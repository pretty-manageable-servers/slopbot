import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProgramRuntime, programLimits, type ProgramResult } from '../src/program-runtime.js';
import { ConfirmationRequired } from '../src/tools.js';

async function failed(run: Promise<ProgramResult>, pattern: RegExp): Promise<ProgramResult> {
  const result = await run;
  assert.ok(result.error, 'the program should fail');
  assert.match(result.error.message, pattern);
  return result;
}

test('programs await parallel reads, derive arguments, and return only reduced outputs', async () => {
  let active = 0, peak = 0;
  // A read finishes only after two have started, so parallelism is proved without depending on speed.
  let bothStarted!: () => void;
  const barrier = new Promise<void>(resolve => { bothStarted = resolve; });
  const runtime = new ProgramRuntime({ ...programLimits, concurrency: 2 });
  const result = await runtime.run(`
    const values = await Promise.all([1,2,3,4].map(n => tools.read({n})));
    const total = values.reduce((sum, item) => sum + item.value, 0);
    const doubled = await tools.read({n:total});
    text({sum:total, doubled:doubled.value});
  `, ['read'], async (_name, args) => {
    active++; peak = Math.max(peak, active);
    if (active === 2) bothStarted();
    await barrier; active--;
    return { value: Number((args as { n: number }).n) * 2, intermediate: 'not emitted' };
  });
  assert.deepEqual(result.outputs, [{ sum: 20, doubled: 40 }]);
  assert.equal(result.calls, 5); assert.equal(peak, 2);
  assert.ok(!JSON.stringify(result).includes('not emitted'));
});

test('guest code has no Node, host globals, network, timers, or module access', async () => {
  const result = await new ProgramRuntime().run(`
    let imported = false;
    try { await import('node:fs'); imported = true; } catch {}
    text({process:typeof process, require:typeof require, fetch:typeof fetch,
      timer:typeof setTimeout, worker:typeof Worker, imported,
      constructorEscape:tools.read.constructor('return typeof process')()});
  `, ['read'], async () => ({}));
  assert.deepEqual(result.outputs, [{ process: 'undefined', require: 'undefined', fetch: 'undefined', timer: 'undefined', worker: 'undefined', imported: false, constructorEscape: 'undefined' }]);
});

test('CPU, memory, output, call-count, argument-size, and input limits stop programs', async () => {
  await failed(new ProgramRuntime({ ...programLimits, cpuMs: 50 }).run('while(true){}', [], async () => ({})), /interrupted|failed/);
  await failed(new ProgramRuntime({ ...programLimits, memoryBytes: 1024 * 1024 }).run('const a=[]; while(true)a.push({text:"x".repeat(1000)});', [], async () => ({})), /memory|failed|exited/);
  // Output over the limit is cut and the program still succeeds.
  const cut = await new ProgramRuntime({ ...programLimits, maxOutputBytes: 100 }).run('text("x".repeat(101));', [], async () => ({}));
  assert.equal(cut.error, undefined);
  assert.equal(cut.truncatedBytes, 1);
  await failed(new ProgramRuntime({ ...programLimits, maxCalls: 2 }).run('await Promise.all([tools.read({}),tools.read({}),tools.read({})]); text("done");', ['read'], async () => ({})), /limit|failed/);
  await failed(new ProgramRuntime().run('await tools.read({x:"x".repeat(65000)});text("done");', ['read'], async () => ({})), /limit|failed/);
  await failed(new ProgramRuntime({ ...programLimits, maxInputBytes: 100 }).run('text(await tools.read({}));', ['read'], async () => ({ x: 'x'.repeat(101) })), /input budget/);
});

test('wall-clock deadline and cancellation terminate the worker and abort host dispatch', async () => {
  let received: AbortSignal | undefined, called!: () => void;
  const started = new Promise<void>(resolve => { called = resolve; });
  const runtime = new ProgramRuntime({ ...programLimits, timeoutMs: 2000 });
  const controller = new AbortController();
  const program = runtime.run('await tools.read({});text("done");', ['read'], async (_name, _args, _index, signal) => {
    received = signal; called(); return new Promise(() => {});
  }, controller.signal);
  const rejected = assert.rejects(program, /interrupted/);
  await started; controller.abort(); await rejected; assert.equal(received!.aborted, true);
  await failed(new ProgramRuntime({ ...programLimits, timeoutMs: 50 }).run('await tools.read({});', ['read'], async () => new Promise(() => {})), /deadline/);
  // Resource slots and guest state are released after a failure.
  assert.deepEqual((await runtime.run('text(typeof priorRun);', [], async () => ({}))).outputs, ['undefined']);
});

test('unresolved promises fail instead of silently completing', async () => {
  await failed(new ProgramRuntime().run('await new Promise(()=>{});', [], async () => ({})), /promise/);
});

test('a guest limit keeps earlier outputs', async () => {
  // Guest messages arrive in order, so 'first' is handled before the CPU limit message.
  // The CPU limit counts guest run time only, so worker startup on a slow runner does not affect it.
  const result = await failed(new ProgramRuntime({ ...programLimits, cpuMs: 200 }).run('text("first"); while (true) {}', [], async () => ({})), /interrupted|failed/);
  assert.deepEqual(result.outputs, ['first']);
});

test('a replaced JSON.stringify does not change the return value', async () => {
  const result = await new ProgramRuntime().run('JSON.stringify = () => "not json"; return {a: 1};', [], async () => ({}));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.returned, { a: 1 });
  assert.deepEqual(result.logs, []);
});

test('confirmation keeps the work done so far and names the call; abort still rejects', async () => {
  const confirmation = new ConfirmationRequired({ name: 'write', arguments: {}, operationId: 'op', parentOperationId: 'parent' });
  const stopped = await new ProgramRuntime().run(`
    text('before'); try { await tools.write({}); } catch { text('caught'); } text('after');
  `, ['write'], async () => { throw confirmation; });
  assert.deepEqual(stopped.outputs, ['before']);
  assert.deepEqual(stopped.confirmation, { name: 'write', operationId: 'op' });
  assert.equal(stopped.error, undefined);
  await assert.rejects(new ProgramRuntime().run('text(1);', [], async () => ({}), AbortSignal.abort()), /interrupted/);
});
