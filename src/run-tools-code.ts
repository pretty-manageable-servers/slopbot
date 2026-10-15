import { errorSummary, logError } from './errors.js';
import type { Json } from './domain.js';
import { isPrivateChannel } from './private-chat.js';
import { stableJson } from './prompt-cache.js';
import { ProgramRuntime, programBuiltins, type ProgramDispatch } from './program-runtime.js';
import type { RecordStore } from './records.js';
import type { SandboxProfile } from './sandbox-profile.js';
import { resolveSandboxPath, sandboxSession } from './sandbox-session.js';
import type { SandboxProvider } from './sandbox.js';
import { ConfirmationRequired, ToolError, stableOperationId, toolResult, type ToolArgs, type ToolDefinition, type ToolRegistry, type ToolResult } from './tools.js';

export const RUN_TOOLS_CODE = 'run_tools_code';

export interface RunToolsCodeOptions {
  runtime?: ProgramRuntime;
  /** Needed by save_to_sandbox. */
  store?: RecordStore;
  /** Needed by save_to_sandbox. */
  sandbox?: SandboxProvider;
  /** The probed profile. Its home is where relative save_to_sandbox paths start. */
  profile?: SandboxProfile;
  /** Stores the pending call of a confirmation. Without it the program still stops at the call. record reads the saved state of a call's confirmation. */
  confirmations?: { record(server: string, operationId: string): Promise<Json | undefined>; save(server: string, operationId: string, value: Json): Promise<void> };
}

const builtinNames = new Set<string>(programBuiltins);
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/\.\s/);
  return end >= 0 ? flat.slice(0, end + 1) : flat;
};

const isArgs = (value: unknown): value is ToolArgs => typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when the requester clicked Cancel on this call's confirmation. The record is written as { done: true, cancelled: true }. */
const isCancelled = (value: Json | undefined): boolean => isArgs(value) && (value as Record<string, Json>).done === true && (value as Record<string, Json>).cancelled === true;

/** The argument names of a tool: its fields, or the properties of its input schema for a tool that has no fields (MCP). */
function argumentNames(tool: ToolDefinition): { name: string; required: boolean }[] {
  const fields = Object.entries(tool.fields);
  if (fields.length) return fields.map(([name, field]) => ({ name, required: field.required === true }));
  const schema = tool.inputSchema as unknown as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const required = schema?.required ?? [];
  return Object.keys(schema?.properties ?? {}).map(name => ({ name, required: required.includes(name) }));
}

/** Reads the value a program gave as tool arguments. No value is {}. A bare value is wrapped as { name: value } when the tool has exactly one required argument, or exactly one argument. */
function normalizeArgs(tool: ToolDefinition | undefined, input: unknown): unknown {
  if (input === undefined || input === null) return {};
  if (isArgs(input) || !tool) return input;
  const names = argumentNames(tool);
  const required = names.filter(item => item.required);
  const only = required.length === 1 ? required[0] : names.length === 1 ? names[0] : undefined;
  return only ? { [only.name]: input as Json } : input;
}

/** The error for an argument value that is not an object. It lists the argument names the tool takes. */
function argumentError(tool: ToolDefinition): ToolError {
  const names = argumentNames(tool).map(item => item.required ? `${item.name} (required)` : item.name);
  return new ToolError(`Tool arguments must be an object. ${tool.name} takes: ${names.length ? names.join(', ') : 'no arguments'}.`);
}

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

/** A program outcome as the model reads it. The contract fields are optional here, so a result without them still works. */
export interface ProgramOutcome {
  outputs: Json[];
  returned?: Json;
  logs?: string[];
  receipts?: { id: number; name: string; status: 'ok' | 'failed' | 'unfinished'; bytes: number }[];
  failures: { name: string; error: string }[];
  error?: { message: string; status: 'failed' | 'rejected' };
}

const plainText = (value: Json): string => typeof value === 'string' ? value : JSON.stringify(value);
const byteSize = (bytes: number): string => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
const receiptText = (receipt: NonNullable<ProgramOutcome['receipts']>[number]): string =>
  receipt.status === 'ok' ? `${receipt.name} ok ${byteSize(receipt.bytes)}` : `${receipt.name} ${receipt.status}`;

/** The text the model reads for a program outcome. Empty parts are skipped. */
export function programText(result: ProgramOutcome): string {
  const logs = result.logs ?? [], receipts = result.receipts ?? [];
  const returned = result.returned;
  const empty = !result.outputs.length && returned === undefined && !logs.length;
  const parts: string[] = [];
  if (result.error) parts.push(`Program failed: ${result.error.message}`);
  if (result.failures.length) parts.push(`Incomplete program result: ${result.failures.length} tool call(s) failed. ${result.failures.map(failure => `${failure.name}: ${failure.error}`).join('; ')}`);
  parts.push(...result.outputs.map(plainText));
  if (returned !== undefined) parts.push(plainText(returned));
  if (logs.length) parts.push(['Logs:', ...logs].join('\n'));
  if (receipts.length && (result.error || empty)) parts.push(`Calls: ${receipts.map(receiptText).join(', ')}`);
  if (empty && !result.error) parts.push('No output. The call results are not shown. To see data, return it or pass it to text().');
  return parts.join('\n');
}

/** Creates the run_tools_code tool. It runs JavaScript in the QuickJS worker and calls other tools as tools.NAME(arguments). */
export function runToolsCodeTool(registry: ToolRegistry, options: RunToolsCodeOptions = {}): ToolDefinition {
  const runtime = options.runtime ?? new ProgramRuntime();
  return {
    name: RUN_TOOLS_CODE, surface: 'top', access: 'member', effect: 'read', retrySafe: true,
    description: 'Compose bot tools in JavaScript using top-level await, Promise.all, loops, and conditions. Call tools as tools.NAME({...}) or NAME({...}) for any tool in the catalog below or any tool that list_tools() returns; each call returns the tool structured data, or { text } for a tool without structured data. Built-ins: list_tools() returns the tools you can use; describe_tool(name) returns a tool full argument schema; save_to_sandbox(path, data) writes a string, or JSON for other data, to a file in the sandbox, relative to the sandbox home directory. Writes are allowed. A write that needs confirmation stops the program: the requester gets Confirm and Cancel buttons. Your code is the body of an async function. End with `return <value>`: a compact JSON-serializable result, including URLs or message IDs needed for evidence. console.log/warn/error output is returned as logs. text(value) also adds output. No Node, imports, network, filesystem, processes, timers, or persistent state. Limits: 64 calls, 4 simultaneous calls, 60 seconds elapsed, 2 seconds guest CPU, 32 MiB guest memory, 1 MB total tool data, 16 KB emitted output. Tool failures reject their promises; caught failures are still reported. Core catalog:\n' + catalogLines(registry),
    fields: {
      code: { type: 'string', required: true, max: 16000, description: 'JavaScript async function body. End with return <result>.' },
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
      const builtin = async (name: string, raw: unknown, index: number): Promise<Json> => {
        const input: ToolArgs = isArgs(raw) ? raw : {};
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
        if (!options.store || !options.sandbox) throw new ToolError('The sandbox is not available.', 'failed');
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        const { session, home: sessionHome } = await sandboxSession(options.store, options.sandbox, message, stableOperationId(parentId, 'sandbox', String(index), path));
        const home = options.profile?.home ?? sessionHome;
        const full = resolveSandboxPath(path, home);
        if (!full.startsWith(`${home}/`)) throw new ToolError(`Path must be inside ${home}: ${path}`);
        await session.write(full, text);
        return { path: full, bytes: Buffer.byteLength(text) };
      };
      const dispatch: ProgramDispatch = async (name, input, index, signal) => {
        await context.assertActive();
        if (builtinNames.has(name)) return builtin(name, input, index);
        // The tool is looked up now, so a definition that changed during the run is used. Access is checked per call.
        const current = registry.definitions().find(item => item.name === name);
        const values = normalizeArgs(current, input);
        if (current && !isArgs(values)) throw argumentError(current);
        const clean = registry.validate(name, values);
        const operationId = stableOperationId(parentId, 'program', String(index), name, stableJson(clean));
        const call = { name, operationId, status: 'running' }; childCalls.push(call);
        const started = performance.now();
        const childReport = (status: 'running' | 'completed' | 'rejected' | 'failed', reused = false, reason?: string) => report({ id: operationId, name, arguments: clean, status, reused, parentId, ...(reason ? { reason } : {}), ...(status !== 'running' ? { durationMs: Math.round(performance.now() - started) } : {}) });
        await childReport('running');
        try {
          const previous = await registry.recordedOperation(operationId);
          // A confirmation is asked once: a call that already has a journal entry is replayed, not asked again.
          if (!previous && current?.confirm?.(clean)) {
            const saved = await options.confirmations?.record(message.server, operationId);
            // Cancel ended this call. The program gets a normal result, and no new confirmation is posted.
            if (isCancelled(saved)) {
              call.status = 'rejected'; await childReport('rejected', false, 'cancelled');
              return `Cancelled by ${message.author}. Ask before trying again.`;
            }
            // Confirm was given. Its result is in the journal, so the call below uses it.
            if ((saved as Record<string, Json> | undefined)?.done !== true) {
              await options.confirmations?.save(message.server, operationId, { name, arguments: clean, parentOperationId: parentId, channel: message.channel, author: message.author, createdAt: Date.now() });
              throw new ConfirmationRequired({ name, arguments: clean, operationId, parentOperationId: parentId });
            }
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
      // A program error is a normal result: outputs, logs and receipts are kept in data.
      return { text: programText(result), data: { ...result, childCalls, limits } as unknown as Json,
        sources: [...sources.values()], artifacts: [...artifacts.values()] };
    },
  };
}
