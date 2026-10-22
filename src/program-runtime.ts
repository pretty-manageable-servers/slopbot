import { Worker } from 'node:worker_threads';
import type { Json } from './domain.js';
import { ConfirmationRequired, ToolError, UncertainActionError } from './tools.js';

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
export interface ProgramCallReceipt { id: number; name: string; status: 'ok' | 'failed' | 'unfinished'; bytes: number }
export interface ProgramResult {
  outputs: Json[];            // text(...) values, in order
  returned?: Json;            // the program's return value; absent when undefined
  logs: string[];             // console lines; '[WARN] ' and '[ERROR] ' prefixes
  calls: number;
  receipts: ProgramCallReceipt[];
  failures: { name: string; error: string }[];
  error?: { message: string; status: 'failed' | 'rejected' }; // the program failed; partial data above is kept
  truncatedBytes?: number;    // output past maxOutputBytes that was cut; the first part is kept
  confirmation?: { name: string; operationId: string }; // the program stopped at a call that needs Confirm; partial data above is kept
}
/** args is whatever the guest sent, parsed from JSON. The dispatcher decides what is a valid argument value. */
export type ProgramDispatch = (name: string, args: unknown, index: number, signal: AbortSignal) => Promise<Json>;

const maxLogLines = 64, maxLogText = 1000;
/** The part of a JSON output that fits in room bytes, and how many bytes were cut. A string keeps its text; other values keep their JSON. */
function headOf(json: string, room: number): { kept: Json; cut: number } {
  const value = JSON.parse(json) as Json;
  const whole = typeof value === 'string' ? value : json;
  const bytes = Buffer.byteLength(whole);
  if (bytes <= room) return { kept: value, cut: 0 };
  const head = Buffer.from(whole).subarray(0, Math.max(0, room)).toString('utf8').replace(/\uFFFD$/, '');
  return { kept: head, cut: bytes - Buffer.byteLength(head) };
}
/** Guest errors name the sandbox limits: a missing global is almost always Node code (require, process, fs). */
function guestErrorText(message: string): string {
  const missing = /^'?([A-Za-z_$][\w$]*)'? is not defined/.exec(message);
  return missing ? `${missing[1]} is not defined. The sandbox has no Node modules, so no require, imports, process or file system. Call tools as tools.NAME({...}) or NAME({...}).` : message;
}

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
        const allowed = new Set<string>([...names, ...programBuiltins]), outputs: Json[] = [], logs: string[] = [], failures: ProgramResult['failures'] = [];
        const receipts = new Map<number, ProgramCallReceipt>();
        const queue: { id: number; name: string; args: unknown }[] = [];
        let finished = false, calls = 0, running = 0, inputBytes = 0, outputBytes = 0, truncatedBytes = 0, completed = false, transientFailure = false, logsDropped = false;
        let returned: Json | undefined;
        const timer = setTimeout(() => finish(new ToolError('Program exceeded its wall-clock deadline.', 'failed')), this.limits.timeoutMs);
        const abort = () => finish(new ToolError('Program interrupted.'), true);
        // Only abort and transient-failure stops reject. A confirmation and every other stop resolve, so outputs,
        // logs and call receipts reach the caller. A confirmation also names the call that waits for Confirm.
        const finish = (error?: Error, rejects = false) => {
          if (finished) return;
          finished = true; clearTimeout(timer); invocationSignal.removeEventListener('abort', abort);
          if (error && rejects && !(error instanceof ConfirmationRequired)) { reject(error); return; }
          const result: ProgramResult = { outputs, logs, calls, receipts: [...receipts.values()].map(receipt => ({ ...receipt })), failures };
          if (returned !== undefined) result.returned = returned;
          if (truncatedBytes) result.truncatedBytes = truncatedBytes;
          if (error instanceof ConfirmationRequired) result.confirmation = { name: error.call.name, operationId: error.call.operationId };
          else if (error) result.error = { message: error.message, status: error instanceof ToolError ? error.status : 'failed' };
          resolve(result);
        };
        invocationSignal.addEventListener('abort', abort, { once: true });
        try {
          worker = new Worker(new URL('./adapters/program-worker.js', import.meta.url), {
            // The worker only guards a single output value; the host cuts output to maxOutputBytes and keeps the first part.
            workerData: { code, names, limits: { ...this.limits, maxOutputBytes: this.limits.maxInputBytes } }, env: {}, execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
          });
        } catch (error) { finish(new ToolError('Program worker could not start.', 'failed', { cause: error })); return; }
        const pump = () => {
          if (finished) return;
          while (running < this.limits.concurrency && queue.length) {
            const call = queue.shift()!;
            const receipt = receipts.get(call.id)!;
            running++;
            void (async () => {
              try {
                const result = await dispatch(call.name, call.args, call.id, invocationSignal);
                if (finished) return;
                const json = JSON.stringify(result);
                if (json === undefined) throw new ToolError('Tool returned no structured data.');
                const bytes = Buffer.byteLength(json);
                inputBytes += bytes;
                if (inputBytes > this.limits.maxInputBytes) { finish(new ToolError('Program tool results exceeded the input budget.')); return; }
                receipt.status = 'ok'; receipt.bytes = bytes;
                worker!.postMessage({ kind: 'result', id: call.id, json });
              } catch (error) {
                if (finished) return;
                // A confirmation stops the whole program, even when the guest code catches the error.
                if (error instanceof ConfirmationRequired) { finish(error, true); return; }
                // A ToolError or an uncertain write is a normal failed result the model reads in this turn. Any other error is transient.
                const known = error instanceof ToolError || error instanceof UncertainActionError;
                const reason = known ? error.message.slice(0, 500) : 'Tool failed. Inspect its recorded result before retrying.';
                if (!known) transientFailure = true;
                failures.push({ name: call.name, error: reason });
                receipt.status = 'failed';
                worker!.postMessage({ kind: 'result', id: call.id, error: reason });
              } finally {
                running--; pump();
                if (completed && !running && !queue.length && !finished) finish();
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
              const id = item.id as number;
              receipts.set(id, { id, name: item.name, status: 'unfinished', bytes: 0 });
              queue.push({ id, name: item.name, args: JSON.parse(item.json) as unknown }); pump();
            } else if (item.kind === 'text') {
              if (typeof item.json !== 'string') throw new ToolError('Program output must be JSON serializable.');
              // Output past the limit is cut, not fatal: the program keeps running and the model is told how much was cut.
              const room = this.limits.maxOutputBytes - outputBytes;
              if (outputs.length >= 32 || room <= 0) { truncatedBytes += Buffer.byteLength(item.json); return; }
              const { kept, cut } = headOf(item.json, room);
              if (cut) { outputBytes = this.limits.maxOutputBytes; truncatedBytes += cut; } else outputBytes += Buffer.byteLength(item.json);
              outputs.push(kept);
            } else if (item.kind === 'log') {
              if (typeof item.text !== 'string' || (item.level !== 'log' && item.level !== 'warn' && item.level !== 'error')) throw new ToolError('Invalid program bridge message.');
              // Logs are a notice when they run out of room, so they are dropped with one warning line, not an error.
              if (logsDropped) return;
              const prefix = item.level === 'warn' ? '[WARN] ' : item.level === 'error' ? '[ERROR] ' : '';
              const line = prefix + item.text.slice(0, maxLogText), bytes = Buffer.byteLength(line);
              if (logs.length >= maxLogLines) {
                logsDropped = true; logs.push(`[WARN] Log line limit (${maxLogLines}) reached; later logs dropped.`);
                return;
              }
              if (outputBytes + bytes > this.limits.maxOutputBytes) {
                logsDropped = true; logs.push('[WARN] Output limit reached; later output dropped.');
                return;
              }
              outputBytes += bytes; logs.push(line);
            } else if (item.kind === 'done') {
              completed = true;
              if (typeof item.json === 'string') {
                const { kept, cut } = headOf(item.json, this.limits.maxOutputBytes - outputBytes);
                if (cut) { outputBytes = this.limits.maxOutputBytes; truncatedBytes += cut; } else outputBytes += Buffer.byteLength(item.json);
                returned = kept;
              }
              // Fire-and-forget tool requests still belong to this program.
              // Wait for their journaled results before returning to the model.
              if (!running && !queue.length) finish();
            } else if (item.kind === 'error') {
              if (transientFailure) { finish(new Error('Program failed after a transient tool failure. Completed reads remain journaled.'), true); return; }
              throw new ToolError(typeof item.error === 'string' ? guestErrorText(item.error.slice(0, 1000)) : 'runtime error', 'failed');
            }
            else throw new ToolError('Invalid program bridge message.');
          } catch (error) { finish(error instanceof Error ? error : new ToolError('Program bridge failed.', 'failed')); }
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
