import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProgramRuntime, programLimits, type ProgramResult } from '../src/program-runtime.js';
import { ConfirmationRequired, ToolError } from '../src/tools.js';

async function failed(run: Promise<ProgramResult>, pattern: RegExp): Promise<ProgramResult> {
  const result = await run;
  assert.ok(result.error, 'the program should fail');
  assert.match(result.error.message, pattern);
  return result;
}

test('programs await parallel reads, derive arguments, and return only reduced outputs', async () => {
  let active = 0, peak = 0;
  const runtime = new ProgramRuntime({ ...programLimits, concurrency: 2 });
  const result = await runtime.run(`
    const values = await Promise.all([1,2,3,4].map(n => tools.read({n})));
    const total = values.reduce((sum, item) => sum + item.value, 0);
    const doubled = await tools.read({n:total});
    text({sum:total, doubled:doubled.value});
  `, ['read'], async (_name, args) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
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
  await failed(new ProgramRuntime({ ...programLimits, maxOutputBytes: 100 }).run('text("x".repeat(101));', [], async () => ({})), /limit|failed/);
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

test('outputs and logs survive a later program error', async () => {
  const result = await failed(new ProgramRuntime().run('text("kept"); console.log("line"); throw new Error("boom");', [], async () => ({})), /boom/);
  assert.deepEqual(result.outputs, ['kept']);
  assert.deepEqual(result.logs, ['line']);
});

test('unfinished calls get receipts', async () => {
  // Guest messages arrive in order. The hang call is sent before the guest error,
  // so dispatch has seen every call when the error ends the program.
  const seen: string[] = [];
  const result = await failed(new ProgramRuntime().run(`
    const first = await tools.fast({});
    try { await tools.bad({}); } catch {}
    text(first);
    tools.hang({});
    throw new Error('stop');
  `, ['fast', 'bad', 'hang'], async name => {
    seen.push(name);
    if (name === 'bad') throw new ToolError('Denied');
    if (name === 'fast') return {};
    return new Promise(() => {});
  }), /stop/);
  assert.deepEqual(seen, ['fast', 'bad', 'hang']);
  assert.deepEqual(result.receipts, [
    { id: 0, name: 'fast', status: 'ok', bytes: 2 },
    { id: 1, name: 'bad', status: 'failed', bytes: 0 },
    { id: 2, name: 'hang', status: 'unfinished', bytes: 0 },
  ]);
});

test('a replaced JSON.stringify does not change the return value', async () => {
  const result = await new ProgramRuntime().run('JSON.stringify = () => "not json"; return {a: 1};', [], async () => ({}));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.returned, { a: 1 });
  assert.deepEqual(result.logs, []);
});

test('confirmation and abort still reject', async () => {
  const confirmation = new ConfirmationRequired({ name: 'write', arguments: {}, operationId: 'op', parentOperationId: 'parent' });
  await assert.rejects(new ProgramRuntime().run(`
    try { await tools.write({}); } catch { text('caught'); }
  `, ['write'], async () => { throw confirmation; }), ConfirmationRequired);
  await assert.rejects(new ProgramRuntime().run('text(1);', [], async () => ({}), AbortSignal.abort()), /interrupted/);
});

test('caught tool failures remain visible and fire-and-forget calls are drained', async () => {
  const runtime = new ProgramRuntime();
  const caught = await runtime.run('try {await tools.read({});}catch{}text("partial");', ['read'], async () => { throw new ToolError('Access revoked'); });
  assert.deepEqual(caught.failures, [{ name: 'read', error: 'Access revoked' }]);
  let finished = false;
  const result = await runtime.run('tools.read({});text("sent");', ['read'], async () => {
    await new Promise(resolve => setTimeout(resolve, 10)); finished = true; return {};
  });
  assert.equal(finished, true); assert.equal(result.calls, 1);
});
