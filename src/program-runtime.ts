import { Worker } from 'node:worker_threads';
import type { Json } from './domain.js';
import { ConfirmationRequired, ToolError } from './tools.js';

export interface ProgramLimits {
  timeoutMs: number;
  cpuMs: number;
  memoryBytes: number;
  maxCalls: number;
  concurrency: number;
  maxOutputBytes: number;
  maxInputBytes: number;
}
export const programLimits: Readonly<ProgramLimits> = Object.freeze({
  timeoutMs: 60000, cpuMs: 2000, memoryBytes: 32 * 1024 * 1024,
  maxCalls: 64, concurrency: 4, maxOutputBytes: 16000, maxInputBytes: 1_000_000,
});
/** Host-handled globals: list_tools(), describe_tool(name), save_to_sandbox(path, data). The worker sends them with these names. */
export const programBuiltins = ['builtin:list_tools', 'builtin:describe_tool', 'builtin:save_to_sandbox'] as const;
export interface ProgramResult { outputs: Json[]; calls: number; failures: { name: string; error: string }[] }
/** args is whatever the guest sent, parsed from JSON. The dispatcher decides what is a valid argument value. */
export type ProgramDispatch = (name: string, args: unknown, index: number, signal: AbortSignal) => Promise<Json>;

// Guest code executes only in QuickJS's WASM heap. The Node worker loads our
// bridge, never evaluates guest code with Node eval, Function, or node:vm.
export class ProgramRuntime {
  private active = 0;
  constructor(readonly limits: Readonly<ProgramLimits> = programLimits, private readonly maxPrograms = 4) {}
  async run(code: string, names: readonly string[], dispatch: ProgramDispatch, signal?: AbortSignal): Promise<ProgramResult> {
    if (signal?.aborted) throw new ToolError('Program interrupted.');
    if (this.active >= this.maxPrograms) throw new ToolError('Program capacity reached. Try again after an active program finishes.');
    this.active++;
    const controller = new AbortController();
    const invocationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let worker: Worker | undefined;
    try {
      return await new Promise<ProgramResult>((resolve, reject) => {
        const allowed = new Set<string>([...names, ...programBuiltins]), outputs: Json[] = [], failures: ProgramResult['failures'] = [];
        const queue: { id: number; name: string; args: unknown }[] = [];
        let finished = false, calls = 0, running = 0, inputBytes = 0, outputBytes = 0, completed = false, transientFailure = false;
        const timer = setTimeout(() => finish(new ToolError('Program exceeded its wall-clock deadline.', 'failed')), this.limits.timeoutMs);
        const abort = () => finish(new ToolError('Program interrupted.'));
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true; clearTimeout(timer); invocationSignal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve({ outputs, calls, failures });
        };
        invocationSignal.addEventListener('abort', abort, { once: true });
        try {
          worker = new Worker(new URL('./adapters/program-worker.js', import.meta.url), {
            workerData: { code, names, limits: this.limits }, env: {}, execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
          });
        } catch (error) { finish(new ToolError('Program worker could not start.', 'failed', { cause: error })); return; }
        const pump = () => {
          if (finished) return;
          while (running < this.limits.concurrency && queue.length) {
            const call = queue.shift()!;
            running++;
            void (async () => {
              try {
                const result = await dispatch(call.name, call.args, call.id, invocationSignal);
                if (finished) return;
                const json = JSON.stringify(result);
                if (json === undefined) throw new ToolError('Tool returned no structured data.');
                inputBytes += Buffer.byteLength(json);
                if (inputBytes > this.limits.maxInputBytes) { finish(new ToolError('Program tool results exceeded the input budget.')); return; }
                worker!.postMessage({ kind: 'result', id: call.id, json });
              } catch (error) {
                if (finished) return;
                // A confirmation stops the whole program, even when the guest code catches the error.
                if (error instanceof ConfirmationRequired) { finish(error); return; }
                const reason = error instanceof ToolError ? error.message.slice(0, 500) : 'Tool failed. Inspect its recorded result before retrying.';
                if (!(error instanceof ToolError)) transientFailure = true;
                failures.push({ name: call.name, error: reason });
                worker!.postMessage({ kind: 'result', id: call.id, error: reason });
              } finally {
                running--; pump();
                if (completed && !running && !queue.length && !finished) {
                  if (!outputs.length) finish(new ToolError('Program must emit a result with text(...).'));
                  else finish();
                }
              }
            })();
          }
        };
        worker.on('message', (message: unknown) => {
          if (finished) return;
          try {
            if (!message || typeof message !== 'object') throw new ToolError('Invalid program bridge message.');
            const item = message as Record<string, unknown>;
            if (item.kind === 'call') {
              if (completed || item.id !== calls || typeof item.name !== 'string' || !allowed.has(item.name) || typeof item.json !== 'string' || Buffer.byteLength(item.json) > 64000) throw new ToolError('Invalid or disallowed program tool call.');
              if (++calls > this.limits.maxCalls) throw new ToolError('Program exceeded its tool-call limit.');
              queue.push({ id: item.id as number, name: item.name, args: JSON.parse(item.json) as unknown }); pump();
            } else if (item.kind === 'text') {
              if (typeof item.json !== 'string') throw new ToolError('Program output must be JSON serializable.');
              outputBytes += Buffer.byteLength(item.json);
              if (outputBytes > this.limits.maxOutputBytes || outputs.length >= 32) throw new ToolError('Program exceeded its output limit.');
              outputs.push(JSON.parse(item.json) as Json);
            } else if (item.kind === 'done') {
              completed = true;
              // Fire-and-forget tool requests still belong to this program.
              // Wait for their journaled results before returning to the model.
              if (!running && !queue.length) {
                if (!outputs.length) throw new ToolError('Program must emit a result with text(...).');
                finish();
              }
            } else if (item.kind === 'error') {
              if (transientFailure) throw new Error('Program failed after a transient tool failure. Completed reads remain journaled.');
              throw new ToolError(`Program failed: ${typeof item.error === 'string' ? item.error.slice(0, 1000) : 'runtime error'}`, 'failed');
            }
            else throw new ToolError('Invalid program bridge message.');
          } catch (error) { finish(error instanceof Error ? error : new ToolError('Program bridge failed.')); }
        });
        worker.once('error', () => finish(new ToolError('Program worker failed or exceeded its memory limit.', 'failed')));
        worker.once('exit', () => { if (!finished) finish(new ToolError('Program worker exited before completion.', 'failed')); });
        if (invocationSignal.aborted) abort();
      });
    } finally {
      controller.abort();
      if (worker) await worker.terminate();
      this.active--;
    }
  }
}
