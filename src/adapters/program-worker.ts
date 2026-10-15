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
function returnedJson(handle: QuickJSHandle): { json?: string; unserializable?: boolean } {
  // The guest stringifies its own return value. The host never evaluates guest source.
  if (vm.typeof(handle) === 'undefined') return {};
  vm.setProp(vm.global, '__returned', handle);
  const result = slice(() => vm.evalCode('(() => { try { return JSON.stringify(__returned); } finally { delete globalThis.__returned; } })()'));
  if (result.error) { result.error.dispose(); return { unserializable: true }; }
  try { return vm.typeof(result.value) === 'string' ? { json: vm.getString(result.value) } : { unserializable: true }; }
  finally { result.value.dispose(); }
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
const log = vm.newFunction('__log', (level, value) => {
  // The guest trims each console line to 1000 characters before it calls this bridge.
  if (ended || vm.typeof(level) !== 'string' || vm.typeof(value) !== 'string') return;
  port.postMessage({ kind: 'log', level: vm.getString(level), text: vm.getString(value) });
});
vm.setProp(vm.global, '__call', call); vm.setProp(vm.global, '__text', text); vm.setProp(vm.global, '__log', log);
call.dispose(); text.dispose(); log.dispose();
const setup = slice(() => vm.evalCode(`(() => {
  const call = __call, emit = __text, record = __log, stringify = JSON.stringify;
  delete globalThis.__call; delete globalThis.__text; delete globalThis.__log;
  const tools = Object.create(null);
  // A missing argument is sent as null; the host reads null and undefined as no arguments.
  const send = (name, args) => call(name, stringify(args) ?? 'null');
  // Console values print as text: strings as they are, other values as JSON, else String(value).
  const show = value => {
    if (typeof value === 'string') return value;
    try { return stringify(value) ?? String(value); }
    catch { try { return String(value); } catch { return '[unprintable]'; } }
  };
  const write = level => (...values) => record(level, values.map(show).join(' ').slice(0, 1000));
  Object.defineProperty(globalThis, 'console', { value: Object.freeze({ log: write('log'), info: write('log'), warn: write('warn'), error: write('error') }) });
  for (const name of ${JSON.stringify(names)}) tools[name] = args => send(name, args);
  // Each tool is also a global NAME(args), unless the name is reserved or already a JavaScript global.
  const reserved = ['tools', 'text', 'list_tools', 'describe_tool', 'save_to_sandbox'];
  for (const name of ${JSON.stringify(names)}) if (!reserved.includes(name) && !(name in globalThis)) Object.defineProperty(globalThis, name, { value: args => send(name, args) });
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
    else if (state.type === 'fulfilled') {
      const returned = returnedJson(state.value);
      state.value.dispose(); ended = true;
      if (returned.unserializable) port.postMessage({ kind: 'log', level: 'warn', text: 'Return value is not JSON serializable.' });
      port.postMessage(returned.json === undefined ? { kind: 'done' } : { kind: 'done', json: returned.json });
    }
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
