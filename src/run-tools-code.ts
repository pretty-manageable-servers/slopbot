import { posix } from 'node:path';
import { errorSummary, logError } from './errors.js';
import type { Json } from './domain.js';
import { isPrivateChannel } from './private-chat.js';
import { stableJson } from './prompt-cache.js';
import { ProgramRuntime, programBuiltins, type ProgramDispatch } from './program-runtime.js';
import type { RecordStore } from './records.js';
import { SANDBOX_HOME, sandboxSession } from './sandbox-session.js';
import type { SandboxProvider } from './sandbox.js';
import { ConfirmationRequired, ToolError, stableOperationId, toolResult, type ToolArgs, type ToolDefinition, type ToolRegistry, type ToolResult } from './tools.js';

export const RUN_TOOLS_CODE = 'run_tools_code';

export interface RunToolsCodeOptions {
  runtime?: ProgramRuntime;
  /** Needed by save_to_sandbox. */
  store?: RecordStore;
  /** Needed by save_to_sandbox. */
  sandbox?: SandboxProvider;
  /** Stores the pending call of a confirmation. Without it the program still stops at the call. */
  confirmations?: { save(server: string, operationId: string, value: Json): Promise<void> };
}

const builtinNames = new Set<string>(programBuiltins);
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/\.\s/);
  return end >= 0 ? flat.slice(0, end + 1) : flat;
};

/** Every tool a program may call: all tools except the top-level ones and run_tools_code. */
function callableTools(registry: ToolRegistry): ToolDefinition[] {
  return registry.definitions().filter(tool => tool.name !== RUN_TOOLS_CODE && tool.surface !== 'top');
}

/** The core catalog: catalog tools sorted by name, one line each. Built once from the registry, so it is the same for every user. */
function catalogLines(registry: ToolRegistry): string {
  return registry.definitions()
    .filter(tool => tool.name !== RUN_TOOLS_CODE && (tool.surface === undefined || tool.surface === 'catalog'))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(tool => `- ${tool.name}(${Object.entries(tool.fields).map(([key, field]) => field.required ? key : `${key}?`).join(', ')}): ${oneLine(tool.description)}`)
    .join('\n');
}

/** Creates the run_tools_code tool. It runs JavaScript in the QuickJS worker and calls other tools as tools.NAME(arguments). */
export function runToolsCodeTool(registry: ToolRegistry, options: RunToolsCodeOptions = {}): ToolDefinition {
  const runtime = options.runtime ?? new ProgramRuntime();
  return {
    name: RUN_TOOLS_CODE, surface: 'top', access: 'member', effect: 'read', retrySafe: true,
    description: 'Compose bot tools in JavaScript using top-level await, Promise.all, loops, and conditions. Call tools.NAME(arguments) for any tool in the catalog below or any tool that list_tools() returns; each call returns the tool structured data, or { text } for a tool without structured data. Built-ins: list_tools() returns the tools you can use; describe_tool(name) returns a tool full argument schema; save_to_sandbox(path, data) writes a string, or JSON for other data, to a file in the sandbox under /home/user. Writes are allowed. A write that needs confirmation stops the program: the requester gets Confirm and Cancel buttons. Emit a compact JSON-serializable result with text(value), including URLs or message IDs needed for evidence. No Node, imports, network, filesystem, processes, timers, or persistent state. Limits: 64 calls, 4 simultaneous calls, 60 seconds elapsed, 2 seconds guest CPU, 32 MiB guest memory, 1 MB total tool data, 16 KB emitted output. Tool failures reject their promises; caught failures are still reported. Core catalog:\n' + catalogLines(registry),
    fields: {
      code: { type: 'string', required: true, max: 16000, description: 'JavaScript async function body. Emit the reduced result with text(...).' },
    },
    authorize: async context => {
      // Returning a cached parent result must not bypass a child's access check after permissions have changed.
      const previous = await registry.recordedResult(context.operationId);
      const saved = previous?.data as { childCalls?: { operationId: string }[] } | undefined;
      for (const child of saved?.childCalls ?? []) {
        const operation = await registry.recordedOperation(child.operationId);
        if (operation) await registry.authorizeCall(context.message, operation.name, operation.args, operation.id, context.source, context.invocation?.expectedVersion);
      }
    },
    execute: async (context, args) => {
      const message = context.message, parentId = context.operationId, code = String(args.code);
      const sources = new Map<string, NonNullable<ToolResult['sources']>[number]>();
      const artifacts = new Map<string, NonNullable<ToolResult['artifacts']>[number]>();
      const childCalls: { name: string; operationId: string; status: string }[] = [];
      const report = async (activity: import('./tool-activity.js').ToolActivity) => {
        try { await context.invocation?.onActivity?.(activity); } catch (error) { logError('program_tool_status_failed', error, { tool: activity.name, operationId: activity.id }, true); }
      };
      await report({ id: parentId, name: RUN_TOOLS_CODE, arguments: args, status: 'running', code, startedAt: Date.now() });
      const usable = async (tool: ToolDefinition): Promise<boolean> => !(tool.access === 'admin' && !context.isAdmin) && !(isPrivateChannel(message.channel) && tool.scope === 'discord');
      const builtin = async (name: string, input: ToolArgs, index: number): Promise<Json> => {
        if (name === 'builtin:list_tools') {
          const list: Json[] = [];
          for (const tool of callableTools(registry)) if (await usable(tool)) list.push({ name: tool.name, description: tool.description });
          return list;
        }
        if (name === 'builtin:describe_tool') {
          const target = input.name;
          const tool = typeof target === 'string' ? callableTools(registry).find(item => item.name === target) : undefined;
          if (!tool || !await usable(tool)) throw new ToolError(`Unknown or unavailable tool: ${String(target)}`);
          return { name: tool.name, description: tool.description, access: tool.access, effect: tool.effect, fields: tool.fields, inputSchema: tool.inputSchema ?? null, outputSchema: tool.outputSchema ?? null } as unknown as Json;
        }
        // save_to_sandbox
        const path = input.path, data = input.data;
        if (typeof path !== 'string' || path.length > 1024 || !('data' in input)) throw new ToolError('save_to_sandbox needs a path string and data.');
        const full = posix.normalize(path.startsWith('/') ? path : posix.join(SANDBOX_HOME, path));
        if (!full.startsWith(`${SANDBOX_HOME}/`)) throw new ToolError(`Path must be inside ${SANDBOX_HOME}: ${path}`);
        if (!options.store || !options.sandbox) throw new ToolError('The sandbox is not available.', 'failed');
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        const { session } = await sandboxSession(options.store, options.sandbox, message, stableOperationId(parentId, 'sandbox', String(index), full));
        await session.write(full, text);
        return { path: full, bytes: Buffer.byteLength(text) };
      };
      const dispatch: ProgramDispatch = async (name, input, index, signal) => {
        await context.assertActive();
        if (builtinNames.has(name)) return builtin(name, input, index);
        // The tool is looked up now, so a definition that changed during the run is used. Access is checked per call.
        const clean = registry.validate(name, input);
        const operationId = stableOperationId(parentId, 'program', String(index), name, stableJson(clean));
        const call = { name, operationId, status: 'running' }; childCalls.push(call);
        const started = performance.now();
        const childReport = (status: 'running' | 'completed' | 'rejected' | 'failed', reused = false, reason?: string) => report({ id: operationId, name, arguments: clean, status, reused, parentId, ...(reason ? { reason } : {}), ...(status !== 'running' ? { durationMs: Math.round(performance.now() - started) } : {}) });
        await childReport('running');
        try {
          const tool = registry.definitions().find(item => item.name === name);
          const previous = await registry.recordedOperation(operationId);
          // A confirmation is asked once: a call that already has a journal entry is replayed, not asked again.
          if (!previous && tool?.confirm?.(clean)) {
            await options.confirmations?.save(message.server, operationId, { name, arguments: clean, parentOperationId: parentId, channel: message.channel, author: message.author, createdAt: Date.now() });
            throw new ConfirmationRequired({ name, arguments: clean, operationId, parentOperationId: parentId });
          }
          const reused = Boolean(await registry.recordedResult(operationId));
          const output = toolResult(await registry.invokeResult(message, name, clean, operationId, context.source, context.invocation?.expectedVersion, { signal }));
          if (output.status === 'rejected' || output.status === 'failed') throw new ToolError(output.reason ?? output.text, output.status);
          if (output.handoff || output.ui) throw new ToolError('Program tool returned a handoff or UI result. Use a direct call.');
          for (const source of output.sources ?? []) sources.set(stableJson(source), source);
          for (const artifact of output.artifacts ?? []) artifacts.set(artifact.url, artifact);
          call.status = 'completed'; await childReport('completed', reused);
          return (output.data ?? { text: output.text }) as Json;
        } catch (error) {
          call.status = error instanceof ToolError ? error.status : 'failed';
          await childReport(error instanceof ToolError ? error.status : 'failed', false, errorSummary(error)); throw error;
        }
      };
      const limits = { maxCalls: runtime.limits.maxCalls, concurrency: runtime.limits.concurrency };
      let result;
      try {
        result = await runtime.run(code, callableTools(registry).map(tool => tool.name), dispatch, context.invocation?.signal);
      } catch (error) {
        if (!(error instanceof ConfirmationRequired)) throw error;
        return {
          text: `Waiting for ${message.author} to confirm ${error.call.name}. The bot posted Confirm and Cancel buttons.`,
          data: { childCalls, confirmation: { name: error.call.name, operationId: error.call.operationId }, limits } as unknown as Json,
          sources: [...sources.values()], artifacts: [...artifacts.values()],
        };
      }
      const text = (result.failures.length ? `Incomplete program result: ${result.failures.length} tool call(s) failed. ${result.failures.map(failure => `${failure.name}: ${failure.error}`).join('; ')}\n` : '')
        + result.outputs.map(output => typeof output === 'string' ? output : JSON.stringify(output)).join('\n');
      return { text, data: { ...result, childCalls, limits } as unknown as Json,
        sources: [...sources.values()], artifacts: [...artifacts.values()] };
    },
  };
}
