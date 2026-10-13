import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ParticipationGate, type ParticipationOptions } from '../src/participation.js';
import { defaultDecisionThresholds, readParticipationHistory } from '../src/participation-history.js';
import { DecisionClassifier } from '../src/adapters/decisions.js';
import { postgresSql } from '../src/adapters/postgres-database.js';
import { loadConfig } from '../src/config.js';
import { Application } from '../src/application.js';
import { FakeLLM } from '../src/adapters/fake-llm.js';
import { Bot } from '../src/bot.js';
import { UserLimitError } from '../src/user-limiter.js';
import type { TaskWorker } from '../src/queue.js';

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

test('history includes legacy scores and scopes filters without duplicating upgraded messages', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const classifier = new DecisionClassifier({ baseUrl: 'https://example.com', apiKey: 'test', model: 'vane' }, store, async () => Response.json({ answers: {
    addressed: { probabilities: { yes: 0.591 } }, respond: { probabilities: { yes: 0.822 } }, funny: { probabilities: { yes: 0.772 } },
  } }));
  await store.ingest(message); await classifier.classify(message, []);
  let rows = await store.participationHistory('s', 'c', { count: 10 });
  assert.equal(rows.length, 1); assert.equal(rows[0]?.decision.scores?.addressed, 0.591); assert.match(rows[0]!.detail, /Legacy/);
  const gate = new ParticipationGate(classifier, { ...options }, () => 0, store);
  await gate.decide(message, []);
  rows = await store.participationHistory('s', 'c', { count: 10, after: 1000, before: 1001, author: 'a', text: 'SLOPBOT' });
  assert.equal(rows.length, 1); assert.doesNotMatch(rows[0]!.detail, /Legacy/);
  assert.equal((await store.participationHistory('other', 'c', { count: 10 })).length, 0);
  assert.equal((await store.participationHistory('s', 'other', { count: 10 })).length, 0);
  assert.equal((await store.participationHistory('s', 'c', { count: 10, before: 1000 })).length, 0);
  assert.equal((await store.participationHistory('s', 'c', { count: 10, text: '%' })).length, 0);
  await store.remove('s', 'c', '1');
  assert.equal((await store.participationHistory('s', 'c', { count: 10 })).length, 0);
});

test('history SQL translates both bounded paths for PostgreSQL', async () => {
  const statements: string[] = [];
  await readParticipationHistory(async (sql, values) => { const query = postgresSql(sql, values); statements.push(query.sql); assert.equal(query.values.at(-1), 10); return []; }, 's', 'c', { count: 10, after: 1000, before: 2000, author: 'a', messageId: '1', text: '%' });
  assert.equal(statements.length, 2);
  for (const sql of statements) { assert.doesNotMatch(sql, /json_extract|\?/); assert.match(sql, /JOIN messages/); assert.match(sql, /LIMIT \$\d+/); }
});

test('environment cutoffs validate probabilities including boundary values', () => {
  const env = { LLM_MODE: 'mock', DISCORD_BOT_TOKEN: 'test' };
  assert.equal(loadConfig({ ...env, JEV_ADDRESSED_THRESHOLD: '0.5', JEV_FUNNY_THRESHOLD: '0' }).jevThresholds.addressed, 0.5);
  assert.equal(loadConfig({ ...env, JEV_FUNNY_THRESHOLD: '1' }).jevThresholds.funny, 1);
  for (const value of ['', '-0.1', '1.1', 'NaN']) assert.throws(() => loadConfig({ ...env, JEV_ADDRESSED_THRESHOLD: value }), /0 to 1/);
});

test('a classified direct call receives the usage-limit notice and why records the block', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const gate = new ParticipationGate({ async classify() { return { respond: true, addressed: true, reason: 'direct' }; } }, { ...options }, () => 0, store);
  const outputs: string[] = [];
  const app = new Application(store, new FakeLLM(), { allowedChannels: [{ server: 's', channel: 'c' }] });
  const worker = { async enqueue() { throw new UserLimitError(Date.now() + 10000); } } as unknown as TaskWorker;
  const bot = new Bot(app, store, store, { async reply(_message, text) { outputs.push(text); return []; }, async createTaskThread() { return 'thread'; }, typing() { return () => {}; } }, 's', ['c'], { participation: gate, worker });
  await bot.receive({ ...message, botAuthor: false, mentionsBot: false, repliesToBot: false });
  assert.equal(outputs.length, 1); assert.match(outputs[0]!, /Usage limit reached/);
  assert.equal((await store.participationHistory('s', 'c', { count: 10 }))[0]?.decision.reason, 'usage_limit');
});

test('upstream user mutes are recorded as blocked rather than an allowed mention', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let classified = false;
  const gate = new ParticipationGate({ async classify() { classified = true; return { respond: true, addressed: true, reason: 'direct' }; } }, { ...options }, () => 0, store);
  const app = new Application(store, new FakeLLM(), { allowedChannels: [{ server: 's', channel: 'c' }] });
  const bot = new Bot(app, store, store, { async reply() { assert.fail('Muted messages must not receive replies'); }, async createTaskThread() { return 'thread'; }, typing() { return () => {}; } }, 's', ['c'], { participation: gate, mutedUntil: () => Date.now() + 10000 });
  await bot.receive({ ...message, botAuthor: false, mentionsBot: true, repliesToBot: false });
  assert.equal(classified, false);
  const history = await store.participationHistory('s', 'c', { count: 1 });
  assert.equal(history[0]?.decision.reason, 'muted');
  assert.equal(history[0]?.decision.respond, false);
});
