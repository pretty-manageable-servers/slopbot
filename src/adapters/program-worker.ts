import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten';
import type { ProgramLimits } from '../program-runtime.js';

const port = parentPort!;
const { code, names, limits } = workerData as { code: string; names: string[]; limits: ProgramLimits };
const module = await getQuickJS(), runtime = module.newRuntime();
runtime.setMemoryLimit(limits.memoryBytes); runtime.setMaxStackSize(512 * 1024);
const vm = runtime.newContext(), pending = new Map<number, QuickJSDeferredPromise>();
let calls = 0, remainingCpu = limits.cpuMs, sliceStarted = performance.now(), running = false, ended = false;
runtime.setInterruptHandler(() => performance.now() - sliceStarted > remainingCpu);

function slice<T>(action: () => T): T {
  sliceStarted = performance.now();
  try { return action(); } finally { remainingCpu -= performance.now() - sliceStarted; }
}
function errorText(handle: QuickJSHandle): string {
  // Read a bounded error message inside the guest. Dumping arbitrary guest
  // objects could serialize a huge object or run an unbounded toJSON callback.
  vm.setProp(vm.global, '__error', handle);
  const result = slice(() => vm.evalCode('String(__error && __error.message || __error).slice(0, 1000)'));
  try { return result.error ? 'Execution interrupted or memory exhausted.' : vm.getString(result.value); }
  finally { result.dispose(); }
}
function fail(reason: string) { if (!ended) { ended = true; port.postMessage({ kind: 'error', error: reason }); } }

const call = vm.newFunction('__call', (name, args) => {
  if (ended || calls >= limits.maxCalls || vm.typeof(name) !== 'string' || vm.typeof(args) !== 'string') throw Error('Tool-call limit or bridge error');
  const id = calls++, deferred = vm.newPromise(); pending.set(id, deferred);
  const tool = vm.getString(name), json = vm.getString(args);
  if (json.length > 64000) throw Error('Tool arguments exceed limit');
  port.postMessage({ kind: 'call', id, name: tool, json });
  return deferred.handle;
});
const text = vm.newFunction('__text', value => {
  if (ended || vm.typeof(value) !== 'string') throw Error('Output must be JSON serializable');
  const json = vm.getString(value);
  if (json.length > limits.maxOutputBytes) throw Error('Output exceeds limit');
  port.postMessage({ kind: 'text', json });
});
vm.setProp(vm.global, '__call', call); vm.setProp(vm.global, '__text', text); call.dispose(); text.dispose();
const setup = slice(() => vm.evalCode(`(() => {
  const call = __call, emit = __text, stringify = JSON.stringify;
  delete globalThis.__call; delete globalThis.__text;
  const tools = Object.create(null);
  for (const name of ${JSON.stringify(names)}) tools[name] = args => call(name, stringify(args));
  Object.defineProperty(globalThis, 'tools', { value: Object.freeze(tools) });
  Object.defineProperty(globalThis, 'text', { value: value => emit(stringify(value)) });
  Object.defineProperty(globalThis, 'list_tools', { value: () => call('builtin:list_tools', '{}') });
  Object.defineProperty(globalThis, 'describe_tool', { value: name => call('builtin:describe_tool', stringify({ name })) });
  Object.defineProperty(globalThis, 'save_to_sandbox', { value: (path, data) => call('builtin:save_to_sandbox', stringify({ path, data })) });
})()`));
if (setup.error) { fail('Could not initialize the isolated runtime.'); setup.dispose(); }
else setup.dispose();
const evaluation = ended ? undefined : slice(() => vm.evalCode(`(async () => { "use strict";\n${code}\n})()`));
let program: QuickJSHandle | undefined;
if (evaluation?.error) { fail(errorText(evaluation.error)); evaluation.dispose(); }
else program = evaluation?.value;

function pump() {
  if (running || ended || !program) return;
  running = true;
  try {
    const jobs = slice(() => runtime.executePendingJobs(100));
    if (jobs.error) { fail(errorText(jobs.error)); jobs.dispose(); return; }
    jobs.dispose();
    const state = vm.getPromiseState(program);
    if (state.type === 'rejected') { fail(errorText(state.error)); state.error.dispose(); }
    else if (state.type === 'fulfilled') { state.value.dispose(); ended = true; port.postMessage({ kind: 'done' }); }
    else if (runtime.hasPendingJob()) setImmediate(pump);
    else if (!pending.size) fail('Program is awaiting a promise that no tool can resolve.');
  } catch { fail('Execution interrupted or memory exhausted.'); }
  finally { running = false; }
}
port.on('message', (message: { kind: string; id: number; json?: string; error?: string }) => {
  if (ended) return;
  const deferred = pending.get(message.id);
  if (!deferred) return;
  pending.delete(message.id);
  try {
    if (message.error) {
      const error = vm.newError(message.error); deferred.reject(error); error.dispose();
    } else {
      // The parent supplies only bounded JSON, never executable source.
      const result = slice(() => vm.evalCode(`JSON.parse(${JSON.stringify(message.json)})`));
      if (result.error) { deferred.reject(result.error); result.error.dispose(); }
      else { deferred.resolve(result.value); result.value.dispose(); }
    }
    deferred.dispose(); pump();
  } catch { fail('Could not import tool result into the isolated runtime.'); }
});
pump();
// The parent always terminates this worker, including after a timeout. WASM
// state and unresolved guest promises cannot survive into the next program.
