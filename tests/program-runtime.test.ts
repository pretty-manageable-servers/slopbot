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

test('returns the program return value', async () => {
  const result = await new ProgramRuntime().run('return {sum: 3, items: [1, 2]};', [], async () => ({}));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.returned, { sum: 3, items: [1, 2] });
  assert.deepEqual(result.outputs, []);
  // A return value that cannot be JSON serialized gives a warning and no value.
  const unserializable = await new ProgramRuntime().run('return () => 1;', [], async () => ({}));
  assert.equal(unserializable.returned, undefined);
  assert.equal(unserializable.error, undefined);
  assert.deepEqual(unserializable.logs, ['[WARN] Return value is not JSON serializable.']);
  // A return value over the output limit is cut to its first part, and the program does not fail.
  const over = await new ProgramRuntime({ ...programLimits, maxOutputBytes: 100 }).run('text("kept"); return "x".repeat(200);', [], async () => ({}));
  assert.equal(over.error, undefined);
  assert.deepEqual(over.outputs, ['kept']);
  assert.equal(over.returned, 'x'.repeat(94));
  assert.equal(over.truncatedBytes, 106);
});

test('no return and no text is ok', async () => {
  const result = await new ProgramRuntime().run('const value = 1;', [], async () => ({}));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.outputs, []);
  assert.equal(result.returned, undefined);
  assert.deepEqual(result.logs, []);
});

test('console lines are captured with prefixes', async () => {
  const result = await new ProgramRuntime().run(`
    console.log('a', {b: 1}); console.info('i'); console.warn('w'); console.error('e');
    return 1;
  `, [], async () => ({}));
  assert.deepEqual(result.logs, ['a {"b":1}', 'i', '[WARN] w', '[ERROR] e']);
  assert.equal(result.returned, 1);
});

test('outputs and logs survive a later program error', async () => {
  const result = await failed(new ProgramRuntime().run('text("kept"); console.log("line"); throw new Error("boom");', [], async () => ({})), /boom/);
  assert.deepEqual(result.outputs, ['kept']);
  assert.deepEqual(result.logs, ['line']);
});

test('a guest limit keeps earlier outputs', async () => {
  // Guest messages arrive in order, so 'first' is handled before the CPU limit message.
  // The CPU limit counts guest run time only, so worker startup on a slow runner does not affect it.
  const result = await failed(new ProgramRuntime({ ...programLimits, cpuMs: 200 }).run('text("first"); while (true) {}', [], async () => ({})), /interrupted|failed/);
  assert.deepEqual(result.outputs, ['first']);
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

test('log output counts against the output limit', async () => {
  const result = await new ProgramRuntime({ ...programLimits, maxOutputBytes: 100 }).run(`
    for (let i = 0; i < 40; i++) console.log('line ' + i);
  `, [], async () => ({}));
  assert.equal(result.error, undefined);
  assert.ok(result.logs.length < 40);
  assert.equal(result.logs.at(-1), '[WARN] Output limit reached; later output dropped.');
  assert.ok(result.logs.slice(0, -1).every(line => line.startsWith('line ')));
});

test('the log line cap and the byte budget give different warnings', async () => {
  const lines = await new ProgramRuntime().run(`
    for (let i = 0; i < 70; i++) console.log('l' + i);
  `, [], async () => ({}));
  assert.equal(lines.error, undefined);
  assert.equal(lines.logs.length, 65);
  assert.equal(lines.logs.at(-1), '[WARN] Log line limit (64) reached; later logs dropped.');
  const bytes = await new ProgramRuntime({ ...programLimits, maxOutputBytes: 100 }).run(`
    for (let i = 0; i < 40; i++) console.log('line ' + i);
  `, [], async () => ({}));
  assert.equal(bytes.logs.at(-1), '[WARN] Output limit reached; later output dropped.');
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
