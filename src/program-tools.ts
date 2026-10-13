import { errorSummary, logError } from "./errors.js";
import type { Json } from './domain.js';
import { stableJson } from './prompt-cache.js';
import { ProgramRuntime } from './program-runtime.js';
import { ToolError, toolFailed, stableOperationId, type ToolArgs, type ToolDefinition, type ToolRegistry, type ToolResult } from './tools.js';

export function programTool(registry: ToolRegistry, runtime = new ProgramRuntime()): ToolDefinition {
  return {
    name: 'program_exec', access: 'member', effect: 'read', retrySafe: true,
    description: 'Compose approved read tools in isolated JavaScript using top-level await, Promise.all, loops, and conditions. Pass an explicit array of tool names whose catalog programmatic flag is true. Call tools.NAME(arguments); it returns the tool structured data, not display text. Emit a compact JSON-serializable result with text(value), including URLs or message IDs needed for evidence. No Node, imports, network, filesystem, processes, timers, or persistent state. Writes, recursive programs, and direct-only tools are forbidden. Limits: 32 calls, 4 simultaneous calls, 30 seconds elapsed, 2 seconds guest CPU, 32 MiB guest memory, 1 MB total tool data, 16 KB emitted output. Tool failures reject their promises; caught failures are still reported. Use direct calls for semantic decisions, writes, and UI/artifact validation.',
    fields: {
      code: { type: 'string', required: true, max: 16000, description: 'JavaScript async function body. Emit the reduced result with text(...).' },
      tools: { type: 'json', required: true, max: 2000, description: 'Explicit array of eligible registered tool names. Empty for pure computation; maximum 16.', schema: { type: 'array', items: { type: 'string' }, maxItems: 16, uniqueItems: true } },
    },
    validate: args => {
      if (!Array.isArray(args.tools) || args.tools.length > 16 || args.tools.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(name)) || new Set(args.tools).size !== args.tools.length) throw new ToolError('Choose at most 16 distinct programmatic tool names.');
      return args;
    },
    authorize: async (context, args) => {
      const names = args.tools as string[];
      for (const name of names) {
        const tool = registry.definitions().find(tool => tool.name === name);
        context.invocation?.assertTool?.(name);
        if (!tool?.programmatic || !tool.outputSchema || name === 'program_exec') throw new ToolError(`Tool is not available to programs: ${name}`);
        await registry.checkAccess(context.message, name);
      }
      // Returning a cached parent result must not bypass a child's resource or
      // channel authorization after permissions have changed.
      const previous = await registry.recordedResult(context.operationId);
      if (previous?.data) {
        const saved = previous.data as { childCalls?: { operationId: string }[] };
        for (const child of saved.childCalls ?? []) {
          const operation = await registry.recordedOperation(child.operationId);
          if (!operation || !names.includes(operation.name) || registry.effect(operation.name, operation.args) !== 'read') throw new ToolError('Program tool grant changed. Submit a new request.');
          await registry.authorizeCall(context.message, operation.name, operation.args, operation.id, context.source, context.invocation?.expectedVersion, context.invocation);
        }
      }
    },
    execute: async (context, args) => {
      const names = args.tools as string[], selected = new Map(registry.definitions().map(tool => [tool.name, tool]));
      const sources = new Map<string, NonNullable<ToolResult['sources']>[number]>();
      const artifacts = new Map<string, NonNullable<ToolResult['artifacts']>[number]>();
      const childCalls: { name: string; operationId: string; status: string }[] = [];
      const result = await runtime.run(String(args.code), names, async (name, input, index, signal) => {
        await context.assertActive();
        context.invocation?.assertTool?.(name);
        if (selected.get(name) !== registry.definitions().find(tool => tool.name === name)) throw new ToolError('Program tool connection or policy changed. Submit a new request.');
        // Dynamic action tools are checked using their actual validated arguments.
        // A read declaration on the outer program never authorizes nested writes.
        const clean = JSON.parse(stableJson(registry.validate(name, input))) as ToolArgs;
        if (registry.effect(name, clean) !== 'read') throw new ToolError(`Programs cannot execute writes: ${name}`);
        const operationId = stableOperationId(context.operationId, 'program', String(index), name, stableJson(clean));
        const call = { name, operationId, status: 'running' }; childCalls.push(call);
        const started = performance.now();
        const report = async (status: 'running' | 'completed' | 'rejected' | 'failed', reused = false, reason?: string) => {
          try { await context.invocation?.onActivity?.({ id: operationId, name, arguments: clean, status, reused, ...(reason ? { reason } : {}), ...(status !== 'running' ? { durationMs: Math.round(performance.now() - started) } : {}) }); } catch (error) { logError("program_tool_status_failed", error, { tool: name, operationId }, true); }
        };
        await report('running');
        try {
          const reused = Boolean(await registry.recordedResult(operationId));
          const output = await registry.invokeResult(context.message, name, clean, operationId, context.source, context.invocation?.expectedVersion,
            { ...context.invocation, signal, assertTool: childName => {
              context.invocation?.assertTool?.(childName);
              if (selected.get(childName) !== registry.definitions().find(tool => tool.name === childName)) throw new ToolError('Program tool connection or policy changed.');
            } });
          if (toolFailed(output)) throw new ToolError(output.reason ?? output.text, output.status as 'rejected' | 'failed');
          if (output.handoff || output.ui || output.data === undefined) throw new ToolError('Program tool returned a rejection, handoff, UI, or no structured data. Use a direct call.');
          for (const source of output.sources ?? []) sources.set(stableJson(source), source);
          for (const artifact of output.artifacts ?? []) artifacts.set(artifact.url, artifact);
          call.status = 'completed'; await report('completed', reused);
          return output.data;
        } catch (error) {
          call.status = error instanceof ToolError ? error.status : 'failed';
          await report(error instanceof ToolError ? error.status : 'failed', false, errorSummary(error)); throw error;
        }
      }, context.invocation?.signal);
      const text = (result.failures.length ? `Incomplete program result: ${result.failures.length} tool call(s) failed. ${result.failures.map(failure => `${failure.name}: ${failure.error}`).join('; ')}\n` : '')
        + result.outputs.map(output => typeof output === 'string' ? output : JSON.stringify(output)).join('\n');
      return { text, data: { ...result, childCalls, limits: { maxCalls: runtime.limits.maxCalls, concurrency: runtime.limits.concurrency } } as unknown as Json,
        sources: [...sources.values()], artifacts: [...artifacts.values()] };
    },
  };
}
