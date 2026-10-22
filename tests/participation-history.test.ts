import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ParticipationGate, type ParticipationOptions } from '../src/participation.js';
import { defaultDecisionThresholds } from '../src/participation-history.js';
import { loadConfig } from '../src/config.js';

const options: ParticipationOptions = { enabled: true, contextMessages: 8, cooldownMs: 0, maxUnsolicitedPerHour: 3, reactionFrequency: 100 };
const message = { id: '1', server: 's', channel: 'c', author: 'a', text: 'hi slopbot', timestamp: 1000 };

test('score cutoffs apply live, save historical cutoffs, and preserve sampled outcomes', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const classifier = { async classify() { return { respond: false, addressed: false, reason: 'scores', scores: { addressed: 0.591, respond: 0.822, funny: 0.772 } }; } };
  const gate = new ParticipationGate(classifier, { ...options }, () => 0, store);
  await store.ingest(message);
  assert.equal((await gate.decide(message, [])).respond, false);
  gate.options.thresholds = { ...defaultDecisionThresholds, addressed: 0.5, funny: 0.7 };
  const next = { ...message, id: '2', timestamp: 2000 }; await store.ingest(next);
  const allowed = await gate.decide(next, []);
  assert.equal(allowed.respond, true); assert.equal(allowed.emoji, '😂');
  gate.options.thresholds.addressed = 0.99;
  const history = await store.participationHistory('s', 'c', { count: 10 });
  assert.deepEqual(history.map(r => r.messageId), ['2', '1']);
  assert.equal(history[0]?.thresholds.addressed, 0.5);
  assert.equal(history[1]?.thresholds.addressed, 0.65);
  assert.equal(history[0]?.decision.scores?.funny, 0.772);
  await gate.recordLimit(next);
  assert.equal((await store.participationHistory('s', 'c', { count: 1 }))[0]?.decision.reason, 'usage_limit');
});

test('environment cutoffs validate probabilities including boundary values', () => {
  const env = { LLM_MODE: 'mock', DISCORD_BOT_TOKEN: 'test' };
  assert.equal(loadConfig({ ...env, JEV_ADDRESSED_THRESHOLD: '0.5', JEV_FUNNY_THRESHOLD: '0' }).jevThresholds.addressed, 0.5);
  assert.equal(loadConfig({ ...env, JEV_FUNNY_THRESHOLD: '1' }).jevThresholds.funny, 1);
  for (const value of ['', '-0.1', '1.1', 'NaN']) assert.throws(() => loadConfig({ ...env, JEV_ADDRESSED_THRESHOLD: value }), /0 to 1/);
});
