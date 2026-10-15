import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BreakerHealth } from '../src/llm-health.js';
import { DEFAULT_BREAKER, type BreakerSettings, type LlmDegradedSettings, type LlmModeState } from '../src/llm-mode.js';

const fallback = { baseUrl: 'https://backup.example/v1', model: 'backup-model', zdr: true, contextTokens: 8192, outputTokens: 1024, keySealed: 'sealed' };

function settingsFor(over: Partial<LlmDegradedSettings> = {}): LlmDegradedSettings {
  return { override: 'auto', breaker: { ...DEFAULT_BREAKER }, statusNoteMinutes: 30, ...over };
}

function rig(t: TestContext) {
  t.mock.method(console, 'log', () => {});
  const cfg = { settings: settingsFor() };
  let clock = 1_000_000;
  const health = new BreakerHealth(() => cfg.settings, () => clock);
  return {
    cfg,
    health,
    advance: (seconds: number) => { clock += seconds * 1000; },
    fail: (times: number) => { for (let index = 0; index < times; index++) health.recordFailure('PROVIDER_HTTP_503'); },
  };
}

// Opens the breaker with the given breaker settings.
function openRig(t: TestContext, breaker: BreakerSettings = { ...DEFAULT_BREAKER }) {
  const r = rig(t);
  r.cfg.settings = settingsFor({ breaker });
  r.fail(5);
  return r;
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


test('fallback vs offline by endpoint', t => {
  const r = rig(t);
  r.fail(5);
  assert.equal(r.health.state().mode, 'offline');
  r.cfg.settings = settingsFor({ fallback });
  assert.equal(r.health.state().mode, 'fallback');
  const { keySealed: _key, ...unsealed } = fallback;
  r.cfg.settings = settingsFor({ fallback: unsealed });
  assert.equal(r.health.state().mode, 'fallback');
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

test('opens and sets cooldown', t => {
  const r = openRig(t, { ...DEFAULT_BREAKER, cooldownSeconds: 100 });
  assert.equal(r.health.state().mode, 'offline');
  r.advance(99);
  assert.equal(r.health.trialDue(), false);
  r.advance(1);
  assert.equal(r.health.trialDue(), true);
});

test('trial due only after cooldown', t => {
  const r = openRig(t);
  r.advance(300);
  r.fail(10);
  r.advance(299);
  assert.equal(r.health.trialDue(), false, 'failures while open do not move the retry time');
  assert.equal(r.health.claimTrial(), false);
  r.advance(1);
  assert.equal(r.health.trialDue(), true);
  assert.equal(r.health.trialDue(), true, 'checking does not claim');
});

test('one trial at a time', t => {
  const r = openRig(t);
  r.advance(600);
  assert.equal(r.health.claimTrial(), true);
  assert.equal(r.health.trialDue(), false);
  assert.equal(r.health.claimTrial(), false);
  r.health.endTrial('other');
  assert.equal(r.health.trialDue(), true);
});

test('trial success closes', t => {
  const r = openRig(t);
  r.advance(600);
  assert.equal(r.health.claimTrial(), true);
  r.health.endTrial('success');
  assert.deepEqual({ mode: r.health.state().mode, lastError: r.health.state().lastError }, { mode: 'normal', lastError: undefined });
  r.fail(4);
  assert.equal(r.health.state().mode, 'normal', 'failure count was cleared on close');
});

test('trial outage doubles cooldown up to max', t => {
  const r = openRig(t);
  let wait = 600;
  for (const expected of [1200, 2400, 4800, 7200, 7200]) {
    r.advance(wait - 1);
    assert.equal(r.health.trialDue(), false);
    r.advance(1);
    assert.equal(r.health.claimTrial(), true);
    r.health.endTrial('outage', 'PROVIDER_HTTP_503');
    assert.equal(r.health.state().mode, 'offline');
    assert.equal(r.health.state().lastError, 'PROVIDER_HTTP_503');
    wait = expected;
  }
});

test('trial other releases slot', t => {
  const r = openRig(t);
  r.advance(600);
  assert.equal(r.health.claimTrial(), true);
  r.health.endTrial('other');
  assert.equal(r.health.state().mode, 'offline', 'still open');
  assert.equal(r.health.trialDue(), true, 'the next request can try again at once');
});

test('override blocks trial', t => {
  const r = openRig(t);
  r.advance(600);
  r.cfg.settings = settingsFor({ breaker: { ...DEFAULT_BREAKER }, override: 'offline' });
  assert.equal(r.health.trialDue(), false);
  assert.equal(r.health.claimTrial(), false);
  r.cfg.settings = settingsFor({ breaker: { ...DEFAULT_BREAKER } });
  assert.equal(r.health.trialDue(), true);
});
