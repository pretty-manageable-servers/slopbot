import assert from "node:assert/strict";
import { test } from "node:test";
import { ParticipationGate, LLMClassifier, type ParticipationDecision } from "../src/participation.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Message } from "../src/domain.js";
import type { LLM } from "../src/ports.js";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { Bot } from "../src/bot.js";
import { ProviderError } from '../src/errors.js';
import type { ParticipationRecord } from '../src/participation-history.js';

const message: Message = { id: "1", server: "s", channel: "c", author: "a", text: "Slopbot help" };
const options = { enabled: true, contextMessages: 8, cooldownMs: 60000, maxUnsolicitedPerHour: 1 };
const decision: ParticipationDecision = { respond: true, addressed: false, reason: "helpful" };

test('recent delivered replies raise same-person follow-up scores with decay and retain raw scores in why', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const signals: unknown[] = [];
  const gate = new ParticipationGate({ async classify(_message, _context, followup) { signals.push(followup); return { ...decision, scores: { addressed: 0.48, respond: 0.7 } }; } }, options, undefined, store);
  const followup = { ...message, text: 'do the second one' };
  const outside = await gate.decide(followup, []); assert.equal(outside.respond, false);
  gate.recordReply(message, { ...message, id: 'bot-reply', author: 'slopbot', isBot: true, timestamp: Date.now() - 1000 });
  const inside = await gate.decide({ ...followup, id: 'inside' }, []);
  assert.equal(inside.respond, true); assert.equal(inside.addressed, true);
  assert.ok(inside.scores!.addressed > outside.scores!.addressed); assert.ok(signals[1]);
  const saved = (await store.record('s', 'participation_decision', 'inside'))?.value as unknown as ParticipationRecord;
  assert.match(saved.detail, /raw addressed=0.480, boost=0.24/);
  gate.recordReply(message, { ...message, id: 'old-reply', timestamp: Date.now() - 31000 });
  assert.equal((await gate.decide({ ...followup, id: 'expired' }, [])).respond, false);
});

test('post-reply sensitivity leaves low-score chatter silent and ends when another person speaks', async () => {
  let score = 0.1;
  const gate = new ParticipationGate({ async classify() { return { ...decision, scores: { addressed: score, respond: 0.7 } }; } }, options);
  gate.recordReply(message, { ...message, id: 'reply', timestamp: Date.now() });
  assert.equal((await gate.decide(message, [])).respond, false);
  score = 0.48;
  assert.equal((await gate.decide({ ...message, author: 'someone-else' }, [])).respond, false);
  assert.equal((await gate.decide(message, [])).respond, false);
  assert.equal((await gate.decide({ ...message, channel: 'other-channel' }, [])).respond, false);
});

test('transient classifier failures retry with bounded backoff and why retains the outcome', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let calls = 0; const delays: number[] = [];
  const gate = new ParticipationGate({ async classify() { if (++calls < 3) throw new ProviderError(502); return { ...decision, addressed: true }; } }, options, undefined, store, async ms => { delays.push(ms); });
  assert.equal((await gate.decide(message, [])).respond, true);
  assert.deepEqual(delays, [250, 500]); assert.equal(calls, 3);
  const saved = (await store.record('s', 'participation_decision', message.id))?.value as unknown as ParticipationRecord;
  assert.match(saved.detail, /Recovered after 2 retry/); assert.match(saved.detail, /502/);
  assert.equal(((await store.record('s', 'classifier_health', 'provider'))?.value as { status: string }).status, 'healthy');
});

test('sustained classifier failures publish health and permanent errors are not retried', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let calls = 0; let status = 502;
  const gate = new ParticipationGate({ async classify(): Promise<ParticipationDecision> { calls++; throw new ProviderError(status); } }, options, undefined, store, async () => {});
  assert.equal((await gate.decide(message, [])).retryable, true); assert.equal(calls, 3);
  assert.equal(((await store.record('s', 'classifier_health', 'provider'))?.value as { status: string }).status, 'unavailable');
  status = 401; calls = 0;
  assert.equal((await gate.decide({ ...message, id: 'permanent' }, [])).retryable, false); assert.equal(calls, 1);
});

test('a recent unanswered message is reclassified after provider recovery and answered once', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let available = false; let classified = 0;
  const gate = new ParticipationGate({ async classify() { classified++; if (!available) throw new ProviderError(502); return { ...decision, addressed: true }; } }, options, undefined, store, async () => {});
  const outputs: string[] = []; let delivered!: () => void;
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  const app = new Application(store, new FakeLLM(), { allowedChannels: [{ server: 's', channel: 'c' }] });
  const bot = new Bot(app, store, store, { async reply(_message, text) { outputs.push(text); delivered(); return []; }, async createTaskThread() { return 'thread'; }, typing() { return () => {}; } }, 's', ['c'], { participation: gate, classificationRetryMs: 10 });
  const incoming = { ...message, timestamp: Date.now(), botAuthor: false, mentionsBot: false, repliesToBot: false };
  await bot.receive(incoming); assert.equal(outputs.length, 0); assert.equal(classified, 3);
  available = true;
  let timeout!: ReturnType<typeof setTimeout>;
  try { await Promise.race([delivery, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Recovery did not deliver')), 1000); })]); }
  finally { clearTimeout(timeout); }
  assert.equal(outputs.length, 1); assert.equal(classified, 4);
  const saved = (await store.record('s', 'participation_decision', message.id))?.value as unknown as ParticipationRecord;
  assert.match(saved.detail, /502.*Recovery check:/);
});

test('classifier recovery skips an edited message', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); let calls = 0;
  const gate = new ParticipationGate({ async classify(): Promise<ParticipationDecision> { calls++; throw new ProviderError(502); } }, options, undefined, store, async () => {});
  const app = new Application(store, new FakeLLM(), { allowedChannels: [{ server: 's', channel: 'c' }] });
  const bot = new Bot(app, store, store, { async reply() { throw new Error('Should not reply'); }, async createTaskThread() { return 'thread'; }, typing() { return () => {}; } }, 's', ['c'], { participation: gate, classificationRetryMs: 5 });
  const incoming = { ...message, timestamp: Date.now(), botAuthor: false, mentionsBot: false, repliesToBot: false };
  await bot.receive(incoming); await store.revise({ ...incoming, text: 'cancelled' });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 3);
});

test("concurrent unsolicited replies obey cooldown and hourly limits", async () => {
  const gate = new ParticipationGate({ async classify() { return decision; } }, options);
  const results = await Promise.all([gate.decide(message, []), gate.decide(message, [])]);
  assert.equal(results.filter(result => result.respond).length, 1);
  assert.equal(results[1]?.reason, "hourly_limit");
});

test("name requests bypass unsolicited limits", async () => {
  const gate = new ParticipationGate({ async classify() { return { ...decision, addressed: true }; } }, { ...options, maxUnsolicitedPerHour: 0 });
  assert.equal((await gate.decide(message, [])).respond, true);
});

test("disabled monitoring and failed classifiers remain silent", async () => {
  const classifier = { async classify(): Promise<ParticipationDecision> { throw new Error("unavailable"); } };
  const disabled = new ParticipationGate(classifier, { ...options, enabled: false });
  assert.equal((await disabled.decide(message, [])).reason, "monitoring_disabled");
  const failed = new ParticipationGate(classifier, options);
  assert.equal((await failed.decide(message, [])).reason, "classifier_failed");
});

test("classifier validates JSON and retains raw reasoning", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let runId = ""; const start = store.startRun.bind(store);
  store.startRun = async (id, ...args) => { runId = id; await start(id, ...args); };
  const llm: LLM = { async *stream() {
    yield { kind: "reasoning", payload: { delta: "preserve" } };
    yield { kind: "text", payload: { text: JSON.stringify({ ...decision, addressed: true }) } };
  } };
  const classifier = new LLMClassifier(llm, store);
  assert.equal((await classifier.classify(message, [])).addressed, true);
  assert.ok(store.events(runId).some(event => event.kind === "reasoning"));
});

test("a classified message is not dropped by ingestion deduplication", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const llm = new FakeLLM(); const outputs: string[] = [];
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] });
  const gate = new ParticipationGate({ async classify() { return { ...decision, addressed: true }; } }, options);
  const bot = new Bot(app, store, store, {
    async reply(_message, text) { outputs.push(text); return []; },
    async createTaskThread() { return "thread"; }, typing() { return () => undefined; },
  }, "s", ["c"], { participation: gate });
  const incoming = { ...message, botAuthor: false, mentionsBot: false, repliesToBot: false };
  await bot.receive(incoming); await bot.receive(incoming);
  assert.equal(outputs.length, 1);
});


test("changing cooldown preserves the hourly cap and channel isolation", async () => {
  const gate = new ParticipationGate({ async classify() { return decision; } }, { ...options, cooldownMs: 120000, maxUnsolicitedPerHour: 2 });
  assert.equal((await gate.decide(message, [])).respond, true);
  assert.equal((await gate.decide(message, [])).reason, "cooldown");
  assert.equal((await gate.decide({ ...message, channel: "other" }, [])).respond, true);
  gate.options.cooldownMs = 0;
  assert.equal((await gate.decide(message, [])).respond, true);
  assert.equal((await gate.decide(message, [])).reason, "hourly_limit");
});

test("reaction frequency samples suitable opportunities and handles 0 and 100 exactly", async () => {
  const classifier = { async classify() { return { respond: false, addressed: false, reason: "funny", emoji: "😂" }; } };
  const gate = new ParticipationGate(classifier, { ...options, reactionFrequency: 60 }, () => 0.59);
  assert.equal((await gate.decide(message, [])).emoji, "😂");
  gate.options.reactionFrequency = 0;
  assert.equal((await gate.decide(message, [])).emoji, undefined);
  const sampledOut = new ParticipationGate(classifier, { ...options, reactionFrequency: 60 }, () => 0.6);
  assert.equal((await sampledOut.decide(message, [])).emoji, undefined);
  sampledOut.options.reactionFrequency = 100;
  for (let i = 0; i < 10; i++) assert.equal((await sampledOut.decide(message, [])).emoji, "😂");
  sampledOut.options.enabled = false;
  assert.equal((await sampledOut.decide(message, [])).emoji, undefined);
});

test("unsupported emoji is rejected even at maximum frequency", async () => {
  const gate = new ParticipationGate({ async classify() { return { ...decision, respond: false, emoji: "not-an-emoji" }; } }, { ...options, reactionFrequency: 100 });
  assert.equal((await gate.decide(message, [])).emoji, undefined);
});

test("a funny unaddressed message receives a reaction without a text reply; duplicates do not react twice", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const llm = new FakeLLM(); const reactions: string[] = [];
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] });
  const gate = new ParticipationGate({ async classify() { return { respond: false, addressed: false, reason: "funny", emoji: "🤭" }; } }, { ...options, reactionFrequency: 100 });
  const bot = new Bot(app, store, store, {
    async react(target, emoji) { reactions.push(`${target.id}:${emoji}`); },
    async reply() { assert.fail("Should not reply"); },
    async createTaskThread() { return "thread"; }, typing() { return () => undefined; },
  }, "s", ["c"], { participation: gate });
  const incoming = { ...message, botAuthor: false, mentionsBot: false, repliesToBot: false };
  await bot.receive(incoming); await bot.receive(incoming);
  assert.deepEqual(reactions, ["1:🤭"]);
  assert.equal(llm.prompts.length, 0);
});
