import assert from "node:assert/strict";
import { test } from "node:test";
import { Application } from "../src/application.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { EventLog, engineEvents } from "../src/engine/event-log.js";
import { HarnessInterrupted } from "../src/harness-state.js";
import type { Message } from "../src/domain.js";
import { publishTool } from "../src/run-events.js";
import { webTranscriptKey } from "../src/server-tools.js";
import type { LLM } from "../src/ports.js";

const server = "1528063444874432734", user = "1514413259522838529";
const webChat = "web:chat-1", switchedOn = "1528063444874432735", switchedOff = "1528063444874432736";
const policy = { allowedChannels: [{ server, channel: switchedOn }] };

function setup(t: { after(fn: () => void): void }) {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  store.setSetting(server, webTranscriptKey(switchedOn), true);
  return store;
}

test("a web chat is always saved, and another channel only while its transcript switch is on", async t => {
  const store = setup(t);
  const log = new EventLog();
  log.attach(store);
  const channels = [webChat, switchedOn, switchedOff];
  for (const channel of channels) log.publish({ server, channel }, { type: "turn.start", turn: "m1" });
  await log.idle();
  const counts: number[] = [];
  for (const channel of channels) counts.push((await log.after({ server, channel }, 0, 100)).length);
  assert.deepEqual(counts, [1, 1, 0]);
});

test("a switched-off channel reaches listeners without a seq, and saves no row", async t => {
  const store = setup(t);
  const log = new EventLog();
  log.attach(store);
  const conversation = { server, channel: switchedOff };
  const seen: (number | undefined)[] = [];
  log.subscribe(conversation, envelope => seen.push(envelope.seq));
  log.publish(conversation, { type: "turn.start", turn: "m1" });
  await log.idle();
  assert.deepEqual(seen, [undefined]);
  assert.deepEqual(await log.after(conversation, 0, 100), []);
});

test("50 text deltas of one run are saved as one row with the joined text, and each reaches listeners", async t => {
  const store = setup(t);
  const log = new EventLog();
  log.attach(store);
  const conversation = { server, channel: switchedOn };
  const heard: string[] = [];
  log.subscribe(conversation, envelope => { if (envelope.event.type === "text.delta") heard.push(envelope.event.text); });
  for (let index = 0; index < 50; index++) log.publish(conversation, { type: "text.delta", turn: "m1", run: "r1", text: `${index},` });
  await log.idle();
  const rows = await log.after(conversation, 0, 100);
  assert.deepEqual(rows.map(row => row.event), [{ type: "text.delta", turn: "m1", run: "r1", text: Array.from({ length: 50 }, (_, index) => `${index},`).join("") }]);
  assert.deepEqual(heard, Array.from({ length: 50 }, (_, index) => `${index},`));
});

test("after returns saved events in publish order, and turn returns only that turn's events", async t => {
  const store = setup(t);
  const log = new EventLog();
  log.attach(store);
  const conversation = { server, channel: switchedOn };
  log.publish(conversation, { type: "turn.start", turn: "m1" });
  log.publish(conversation, { type: "round.start", turn: "m1", run: "r1" });
  log.publish(conversation, { type: "text.delta", turn: "m1", run: "r1", text: "Hi" });
  log.publish(conversation, { type: "turn.end", turn: "m1", status: "done" });
  log.publish(conversation, { type: "turn.start", turn: "m2" });
  log.publish(conversation, { type: "turn.end", turn: "m2", status: "failed" });
  await log.idle();
  const all = await log.after(conversation, 0, 100);
  assert.deepEqual(all.map(envelope => envelope.event.type), ["turn.start", "round.start", "text.delta", "turn.end", "turn.start", "turn.end"]);
  const rest = await log.after(conversation, all[3]!.seq!, 100);
  assert.deepEqual(rest.map(envelope => envelope.seq), all.slice(4).map(envelope => envelope.seq));
  assert.deepEqual(await log.turn(conversation, "m1"), all.slice(0, 4).map(envelope => envelope.event));
});

test("latest is the highest saved seq of the conversation, so after(latest) holds only newer events", async t => {
  const store = setup(t);
  const log = new EventLog();
  log.attach(store);
  const conversation = { server, channel: switchedOn };
  assert.equal(await log.latest(conversation), 0);
  log.publish(conversation, { type: "turn.start", turn: "m1" });
  log.publish(conversation, { type: "turn.end", turn: "m1", status: "done" });
  log.publish({ server, channel: "other-channel" }, { type: "turn.start", turn: "x" });
  await log.idle();
  const seen = await log.latest(conversation);
  assert.deepEqual(await log.after(conversation, seen, 100), []);
  log.publish(conversation, { type: "turn.start", turn: "m2" });
  await log.idle();
  assert.deepEqual((await log.after(conversation, seen, 100)).map(envelope => envelope.event), [{ type: "turn.start", turn: "m2" }]);
  assert.ok(await log.latest(conversation) > seen);
});

test("retention deletes rows older than the cutoff, then the oldest rows beyond maxRows", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = setup(t);
  const log = new EventLog();
  log.attach(store);
  const conversation = { server, channel: switchedOn };
  log.publish(conversation, { type: "turn.start", turn: "old" });
  await log.idle();
  t.mock.timers.setTime(10_000);
  log.publish(conversation, { type: "turn.start", turn: "m1" });
  log.publish(conversation, { type: "turn.start", turn: "m2" });
  await log.idle();
  assert.equal(await store.pruneConversationEvents(5_000, 100), 1);
  assert.deepEqual(await log.turn(conversation, "old"), []);
  assert.equal((await log.after(conversation, 0, 100)).length, 2);
  assert.equal(await store.pruneConversationEvents(0, 1), 1);
  assert.deepEqual((await log.after(conversation, 0, 100)).map(envelope => envelope.event), [{ type: "turn.start", turn: "m2" }]);
});

test("tool.status keeps the full arguments and run fields, and keys the call by its provider call ID when it has one", async t => {
  const store = setup(t);
  engineEvents.attach(store);
  t.after(() => engineEvents.attach(undefined as never));
  const request = { id: "m1", server, channel: switchedOn, author: user, authorName: "Ada", text: "make it", timestamp: 1_000 } as Message;
  const content = "x".repeat(2_000);
  publishTool(request, { id: "m1:0", name: "write_file", status: "completed", arguments: { content }, callId: "call_1" });
  publishTool(request, { id: "m1:1", name: "write_file", status: "completed", arguments: {} });
  publishTool(request, { id: "m1:2", name: "run_tools_code", status: "failed", arguments: {}, reason: "why", code: "return 1", parentId: "m1:0", durationMs: 12 });
  await engineEvents.idle();
  assert.deepEqual(await engineEvents.turn({ server, channel: switchedOn }, "m1"), [
    { type: "tool.status", turn: "m1", call: "call_1", name: "write_file", status: "completed", input: { content } },
    { type: "tool.status", turn: "m1", call: "m1:1", name: "write_file", status: "completed", input: {} },
    { type: "tool.status", turn: "m1", call: "m1:2", name: "run_tools_code", status: "failed", input: {}, reason: "why", code: "return 1", parent: "m1:0", durationMs: 12 },
  ]);
});

test("a finished reply logs its turn start, its text, and a done turn end", async t => {
  const store = setup(t);
  engineEvents.attach(store);
  t.after(() => engineEvents.attach(undefined as never));
  const request = { id: "m1", server, channel: switchedOn, author: user, text: "do the task" };
  const llm: LLM = { async *stream() { yield { kind: "text", payload: { text: "Hello" } }; } };
  const app = new Application(store, llm, policy, undefined, { harness: store });
  await app.handle(request);
  await engineEvents.idle();
  const events = await engineEvents.turn({ server, channel: switchedOn }, "m1");
  assert.equal(events[0]?.type, "turn.start");
  assert.ok(events.some(event => event.type === "text.delta" && event.text === "Hello"));
  assert.deepEqual(events.at(-1), { type: "turn.end", turn: "m1", status: "done" });
});

test("an interrupted run ends its turn as interrupted in the engine log", async t => {
  const store = setup(t);
  engineEvents.attach(store);
  t.after(() => engineEvents.attach(undefined as never));
  let notify!: () => void;
  const started = new Promise<void>(resolve => { notify = resolve; });
  const llm: LLM = { async *stream(_prompt, signal) {
    yield { kind: "text", payload: { text: "partial" } };
    notify();
    await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
    signal!.throwIfAborted();
  } };
  const request = { id: "m1", server, channel: switchedOn, author: user, text: "do the task" };
  const app = new Application(store, llm, policy, undefined, { harness: store });
  const pending = app.handle(request);
  await started;
  assert.equal(await app.interrupt(server, "m1"), true);
  await assert.rejects(pending, HarnessInterrupted);
  await engineEvents.idle();
  const events = await engineEvents.turn({ server, channel: switchedOn }, "m1");
  assert.deepEqual(events.at(-1), { type: "turn.end", turn: "m1", status: "interrupted" });
});
