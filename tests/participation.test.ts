import assert from "node:assert/strict";
import { test } from "node:test";
import { ParticipationGate, LLMClassifier, type ParticipationDecision } from "../src/participation.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Message } from "../src/domain.js";
import type { LLM } from "../src/ports.js";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { Bot } from "../src/bot.js";

const message: Message = { id: "1", server: "s", channel: "c", author: "a", text: "Slopbot help" };
const options = { enabled: true, contextMessages: 8, cooldownMs: 60000, maxUnsolicitedPerHour: 1 };
const decision: ParticipationDecision = { respond: true, addressed: false, reason: "helpful" };

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
