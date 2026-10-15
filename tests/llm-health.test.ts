import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BreakerHealth } from '../src/llm-health.js';
import { DEFAULT_BREAKER, type LlmDegradedSettings, type LlmModeState } from '../src/llm-mode.js';

const fallback = { baseUrl: 'https://backup.example/v1', model: 'backup-model', zdr: true, contextTokens: 8192, outputTokens: 1024, keySealed: 'sealed' };

function settingsFor(over: Partial<LlmDegradedSettings> = {}): LlmDegradedSettings {
  return { override: 'auto', breaker: { ...DEFAULT_BREAKER }, statusNoteMinutes: 30, ...over };
}

// Lets the probe promise and its follow-up code run.
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function rig(t: TestContext, probe: () => Promise<boolean> = async () => true) {
  t.mock.method(console, 'log', () => {});
  const cfg = { settings: settingsFor() };
  let clock = 1_000_000;
  const health = new BreakerHealth(() => cfg.settings, probe, () => clock);
  return {
    cfg,
    health,
    advance: (ms: number) => { clock += ms; },
    fail: (times: number) => { for (let index = 0; index < times; index++) health.recordFailure('PROVIDER_HTTP_503'); },
  };
}

test('trips after N failures in window', t => {
  const r = rig(t);
  r.fail(4);
  assert.equal(r.health.state().mode, 'normal');
  r.fail(1);
  assert.deepEqual({ mode: r.health.state().mode, source: r.health.state().source, lastError: r.health.state().lastError }, { mode: 'offline', source: 'breaker', lastError: 'PROVIDER_HTTP_503' });
});

test('old failures expire', t => {
  const r = rig(t);
  r.fail(4);
  r.advance(61_000);
  r.fail(4);
  assert.equal(r.health.state().mode, 'normal');
  r.fail(1);
  assert.equal(r.health.state().mode, 'offline');
});

test('override wins', t => {
  const r = rig(t);
  r.cfg.settings = settingsFor({ fallback });
  r.fail(5);
  assert.deepEqual({ mode: r.health.state().mode, source: r.health.state().source }, { mode: 'fallback', source: 'breaker' });
  r.cfg.settings = settingsFor({ fallback, override: 'normal' });
  assert.deepEqual({ mode: r.health.state().mode, source: r.health.state().source }, { mode: 'normal', source: 'override' });
  r.cfg.settings = settingsFor({ fallback, override: 'offline' });
  assert.deepEqual({ mode: r.health.state().mode, source: r.health.state().source }, { mode: 'offline', source: 'override' });
});

test('fallback vs offline by key', t => {
  const r = rig(t);
  const { keySealed: _key, ...unsealed } = fallback;
  r.cfg.settings = settingsFor({ fallback: unsealed });
  r.fail(5);
  assert.equal(r.health.state().mode, 'offline');
  r.cfg.settings = settingsFor({ fallback });
  assert.equal(r.health.state().mode, 'fallback');
});

test('recovers after probes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probes = 0;
  const r = rig(t, async () => { probes++; return true; });
  r.health.start();
  r.fail(5);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(probes, 1);
  assert.equal(r.health.state().mode, 'offline');
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(probes, 2);
  assert.equal(r.health.state().mode, 'normal');
  r.fail(4);
  assert.equal(r.health.state().mode, 'normal', 'failures were cleared on recovery');
});

test('failed probe resets count', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const results = [true, false, true, true];
  const r = rig(t, async () => results.shift() ?? true);
  r.health.start();
  r.fail(5);
  for (const expected of ['offline', 'offline', 'offline', 'normal']) {
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(r.health.state().mode, expected);
  }
});

test('stop cancels probes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probes = 0;
  const r = rig(t, async () => { probes++; return true; });
  r.health.start();
  r.fail(5);
  r.health.stop();
  t.mock.timers.tick(90_000);
  await flush();
  assert.equal(probes, 0);
  assert.equal(r.health.state().mode, 'offline');
});

test('listener only on change', t => {
  const r = rig(t);
  const seen: LlmModeState[] = [];
  r.health.onChange(state => seen.push(state));
  r.fail(4);
  assert.equal(seen.length, 0);
  r.fail(1);
  assert.deepEqual(seen.map(state => state.mode), ['offline']);
  r.fail(2);
  r.health.recordSuccess();
  assert.equal(seen.length, 1);
  r.cfg.settings = settingsFor({ override: 'normal' });
  r.health.recordSuccess();
  assert.deepEqual(seen.map(state => state.mode), ['offline', 'normal']);
  assert.equal(r.health.state().mode, 'normal');
  assert.equal(seen.length, 2);
});
