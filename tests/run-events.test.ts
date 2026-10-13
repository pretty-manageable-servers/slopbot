import assert from "node:assert/strict";
import { test } from "node:test";
import { EventJournal } from "../src/event-journal.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { RunEvents, publishMessage, publishMessageDelete, publishTool, reasoningText, runEvents, shortArgs, startConversationEventRetention, transcriptMessage, type ConversationEvent } from "../src/run-events.js";
import { webTranscriptKey } from "../src/server-tools.js";
import type { Message } from "../src/domain.js";
import { MemberDirectory } from "../src/member-directory.js";
import { fakeSource } from "./member-fakes.js";

const server = "1528063444874432734", channel = "1528063444874432735", thread = "1528063444874432736", bot = "1528063444874432799";
const user = "1514413259522838529";

function setup(t: { after(fn: () => void): void }, switchOn = true) {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  if (switchOn) store.setSetting(server, webTranscriptKey(channel), true);
  const bus = new RunEvents();
  bus.attach(store);
  return { store, bus };
}
const message = (id: string, text = "hello", extra: Partial<Message> = {}): Message => ({
  id, server, channel, author: user, authorName: "Ada", text, timestamp: 1_000 + Number(id.slice(-3)), ...extra,
});
const saved = (store: SQLiteStore, after = 0): Promise<ConversationEvent[]> => store.conversationEventsAfter(server, channel, after, 1000);

test("stream IDs go up across messages and two runs, in publish order", async t => {
  const { store, bus } = setup(t);
  bus.publish(server, channel, "message", "m1", { action: "upsert" });
  bus.publish(server, channel, "run.start", "run-a", { requestId: "m1" });
  bus.publish(server, channel, "run.end", "run-a", { status: "done" });
  bus.publish(server, channel, "message", "bot-1", { action: "upsert" });
  bus.publish(server, channel, "run.start", "run-b", { requestId: "m2" });
  bus.publish(server, channel, "run.end", "run-b", { status: "failed" });
  await bus.idle();
  const rows = await saved(store);
  assert.deepEqual(rows.map(row => row.kind), ["message", "run.start", "run.end", "message", "run.start", "run.end"]);
  assert.deepEqual(rows.map(row => row.ref), ["m1", "run-a", "run-a", "bot-1", "run-b", "run-b"]);
  const ids = rows.map(row => row.streamId);
  assert.ok(ids.every((id, index) => index === 0 || id > ids[index - 1]!), "IDs must only go up");
});

test("consecutive deltas of one run are saved as one row, with order kept", async t => {
  const { store, bus } = setup(t);
  bus.publish(server, channel, "run.start", "run-a", { requestId: "m1" });
  bus.publish(server, channel, "run.delta", "run-a", { part: "text", text: "Hel" });
  bus.publish(server, channel, "run.delta", "run-a", { part: "text", text: "lo" });
  bus.publish(server, channel, "run.delta", "run-a", { part: "thinking", text: "hmm" });
  bus.publish(server, channel, "run.delta", "run-a", { part: "text", text: "!" });
  bus.publish(server, channel, "message", "bot-1", { action: "upsert" });
  await bus.idle();
  const rows = await saved(store);
  assert.deepEqual(rows.map(row => [row.kind, row.data]), [
    ["run.start", { requestId: "m1" }],
    ["run.delta", { part: "text", text: "Hello" }],
    ["run.delta", { part: "thinking", text: "hmm" }],
    ["run.delta", { part: "text", text: "!" }],
    ["message", { action: "upsert" }],
  ]);
});

test("nothing is published while the channel switch is off, or before a store is attached", async t => {
  const { store, bus } = setup(t, false);
  bus.publish(server, channel, "message", "m1", { action: "upsert" });
  await bus.idle();
  assert.deepEqual(await saved(store), []);
  store.setSetting(server, webTranscriptKey(channel), true);
  bus.changed(server);
  bus.publish(server, channel, "message", "m2", { action: "upsert" });
  await bus.idle();
  assert.deepEqual((await saved(store)).map(row => row.ref), ["m2"]);
  const detached = new RunEvents();
  detached.publish(server, channel, "message", "m3", {});
  await detached.idle();
  assert.equal((await saved(store)).length, 1);
});

test("a thread uses the switch of its parent channel", async t => {
  const { store, bus } = setup(t, false);
  store.registerTask(server, thread, channel, "m1");
  store.setSetting(server, webTranscriptKey(channel), true);
  bus.changed(server);
  bus.publish(server, thread, "message", "t1", { action: "upsert" });
  await bus.idle();
  assert.equal((await store.conversationEventsAfter(server, thread, 0, 10)).length, 1);
  store.setSetting(server, webTranscriptKey(channel), false);
  bus.changed(server);
  bus.publish(server, thread, "message", "t2", { action: "upsert" });
  await bus.idle();
  assert.equal((await store.conversationEventsAfter(server, thread, 0, 10)).length, 1);
});

test("changed() tells the listeners of a server, and unsubscribe stops them", t => {
  const { bus } = setup(t);
  let calls = 0;
  const off = bus.onChange(server, () => calls++);
  bus.changed(server);
  off();
  bus.changed(server);
  assert.equal(calls, 1);
});

test("the journal publishes reply runs live, keeps its own saves, and skips checkpoints", async t => {
  const { store } = setup(t);
  runEvents.attach(store);
  t.after(() => runEvents.attach(undefined as never));
  store.setSetting(server, webTranscriptKey(channel), true);
  const request = message("req-1", "why?");
  await store.startRun("run-reply", request, { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" });
  const journal = new EventJournal(store, "run-reply", request, "model");
  await journal.append({ kind: "reasoning", payload: { reasoning_content: "Let me think." } });
  await journal.append({ kind: "text", payload: { text: "Because " } });
  await journal.append({ kind: "text", payload: { text: "reasons." } });
  await journal.append({ kind: "usage", payload: { prompt_tokens: 3, cost: 0.2 } });
  await journal.close();
  await runEvents.idle();

  const rows = (await saved(store)).filter(row => row.ref === "run-reply");
  assert.deepEqual(rows.map(row => [row.kind, row.data]), [
    ["run.start", { requestId: "req-1" }],
    ["run.delta", { part: "thinking", text: "Let me think." }],
    ["run.delta", { part: "text", text: "Because " }],
    ["run.delta", { part: "text", text: "reasons." }],
    ["run.end", { status: "done" }],
  ]);
  // The journal still saves every raw event, including usage.
  assert.equal(store.events("run-reply").length, 4);

  const checkpoint = new EventJournal(store, "run-check", request, "checkpoint model");
  await checkpoint.append({ kind: "text", payload: { text: "summary" } });
  await checkpoint.close();
  await runEvents.idle();
  assert.equal((await saved(store)).filter(row => row.ref === "run-check").length, 0);
});

test("live messages carry the member's name and avatar from the directory, and webhook posts do not", async t => {
  const { store } = setup(t);
  runEvents.attach(store);
  t.after(() => runEvents.attach(undefined as never));
  store.setSetting(server, "context_bot_author", bot);
  const directory = new MemberDirectory(fakeSource({ [user]: { username: "ada", nickname: "Ada L", serverAvatar: "https://cdn.discordapp.com/guilds/1/users/ada.png", inServer: true }, [bot]: { username: "slopbot", avatar: "https://cdn.discordapp.com/avatars/bot.png", inServer: true } }));
  await publishMessage(store, message("user-2"), undefined, directory);
  await publishMessage(store, { id: "bot-2", server, channel, author: bot, authorName: "Slopbot", text: "Hi", timestamp: 2_000, isBot: true }, [], directory);
  await publishMessage(store, { id: "hook-1", server, channel, author: "1528063444874432888", authorName: "Web Ada", text: "From the web", timestamp: 3_000, isBot: true, source: "web" }, [], directory);
  await runEvents.idle();
  const views = (await saved(store)).filter(row => row.kind === "message").map(row => (row.data as { message: { id: string; authorName: string; username: string | null; avatarUrl: string | null } }).message);
  assert.deepEqual(views.map(view => [view.id, view.authorName, view.username, view.avatarUrl]), [
    ["user-2", "Ada L", "ada", "https://cdn.discordapp.com/guilds/1/users/ada.png"],
    ["bot-2", "slopbot", "slopbot", "https://cdn.discordapp.com/avatars/bot.png"],
    ["hook-1", "Web Ada", null, null],
  ]);
});

test("messages carry the Slopbot flag and run IDs, and edits and deletes publish", async t => {
  const { store } = setup(t);
  runEvents.attach(store);
  t.after(() => runEvents.attach(undefined as never));
  store.setSetting(server, "context_bot_author", bot);
  store.setSetting(server, webTranscriptKey(channel), true);
  await store.startRun("run-x", message("req-2"), { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" });
  const reply: Message = { id: "reply-1", server, channel, author: bot, authorName: "Slopbot", text: "Answer", timestamp: 2_000, revisionTimestamp: 2_500, isBot: true };
  await publishMessage(store, reply, ["run-x"]);
  await publishMessage(store, message("user-1", "Hi there", { timestamp: 1_500 }));
  publishMessageDelete(server, channel, "user-1");
  await runEvents.idle();
  const rows = await saved(store);
  const upsertReply = rows.find(row => row.ref === "reply-1")!;
  assert.deepEqual(upsertReply.data, { action: "upsert", message: { id: "reply-1", channel, author: bot, authorName: "Slopbot", username: null, avatarUrl: null, text: "Answer", timestamp: 2_000, editedAt: 2_500, slopbot: true, runIds: ["run-x"] } });
  const userRow = rows.find(row => row.ref === "user-1" && (row.data as { action: string }).action === "upsert")!;
  assert.equal((userRow.data as { message: { slopbot: boolean; runIds: string[] } }).message.slopbot, false);
  assert.deepEqual((userRow.data as { message: { runIds: string[] } }).message.runIds, []);
  assert.deepEqual(rows.at(-1)!.data, { action: "delete", id: "user-1" });
});

test("tool progress is published with short arguments", async t => {
  const { store } = setup(t);
  runEvents.attach(store);
  t.after(() => runEvents.attach(undefined as never));
  store.setSetting(server, webTranscriptKey(channel), true);
  publishTool(message("req-3"), { id: "turn:0", name: "history_search", arguments: { query: "x".repeat(400) }, status: "running" });
  await runEvents.idle();
  const row = (await saved(store)).at(-1)!;
  assert.equal(row.kind, "run.tool");
  assert.equal(row.ref, "req-3");
  const data = row.data as { args: string; status: string; name: string };
  assert.equal(data.name, "history_search");
  assert.equal(data.status, "running");
  assert.ok(data.args.length <= 301);
});

test("helpers: short arguments, thinking text, and the view shape", () => {
  assert.equal(shortArgs({ a: 1 }), '{"a":1}');
  assert.ok(shortArgs({ text: "y".repeat(1000) }).endsWith("…"));
  assert.equal(reasoningText({ reasoning: "r" }), "r");
  assert.equal(reasoningText({ reasoning_content: "rc", reasoning: "r" }), "rc");
  assert.equal(reasoningText({ other: 1 }), "");
  assert.equal(reasoningText(null as never), "");
  const view = transcriptMessage(message("v-1", "x", { revisionTimestamp: 1_001 }), bot);
  assert.equal(view.editedAt, null);
  assert.equal(view.avatarUrl, null);
  assert.equal(view.slopbot, false);
});

const ALL = Number.MAX_SAFE_INTEGER;
/** Adds rows straight to the store. createdAt is set per row, so age tests need no clock. */
async function addRows(store: SQLiteStore, count: number, createdAt: number, channelId = channel): Promise<number[]> {
  const ids: number[] = [];
  for (let index = 0; index < count; index++) ids.push(await store.appendConversationEvent({ server, channel: channelId, kind: "run.delta", ref: "run", data: { part: "text", text: String(index) }, createdAt }));
  return ids;
}

test("age prune deletes rows older than the cutoff and keeps newer ones", async t => {
  const { store } = setup(t);
  await addRows(store, 3, 1_000);
  const fresh = await addRows(store, 2, 9_000);
  assert.equal(await store.pruneConversationEvents(5_000, 1_000_000), 3);
  assert.deepEqual((await saved(store)).map(event => event.streamId), fresh);
  assert.equal(await store.pruneConversationEvents(5_000, 1_000_000), 0);
});

test("row cap keeps the newest maxRows rows and deletes the oldest by stream ID", async t => {
  const { store } = setup(t);
  const ids = await addRows(store, 10, 1_000);
  assert.equal(await store.pruneConversationEvents(0, 4), 6);
  assert.deepEqual((await saved(store)).map(event => event.streamId), ids.slice(6));
  assert.equal(await store.pruneConversationEvents(0, 4), 0);
});

test("age and cap work together: old rows go first, then the cap counts what is left", async t => {
  const { store } = setup(t);
  await addRows(store, 4, 1_000);
  const kept = await addRows(store, 5, 9_000);
  assert.equal(await store.pruneConversationEvents(5_000, 3), 6);
  assert.deepEqual((await saved(store)).map(event => event.streamId), kept.slice(2));
});

test("a prune larger than one batch runs in batches: age first, then the cap across batches", async t => {
  const { store } = setup(t);
  await addRows(store, 25_000, 1_000);
  assert.equal(await store.pruneConversationEvents(5_000, ALL), 25_000);
  assert.equal((await saved(store)).length, 0);
  await addRows(store, 25_000, 9_000);
  const newest = (await addRows(store, 1_000, 9_000)).at(-1)!;
  // 26,000 fresh rows, cap 1,000: the cap removes 25,000 in three statements (10,000 + 10,000 + 5,000).
  assert.equal(await store.pruneConversationEvents(5_000, 1_000), 25_000);
  const rest = await saved(store);
  assert.equal(rest.length, 1_000);
  assert.equal(rest.at(-1)!.streamId, newest);
});

test("oldestStreamId is the lowest kept row of the channel, or undefined when none is kept", async t => {
  const { store } = setup(t);
  assert.equal(await store.oldestStreamId(server, channel), undefined);
  const ids = await addRows(store, 3, 1_000);
  assert.equal(await store.oldestStreamId(server, channel), ids[0]);
  assert.equal(await store.pruneConversationEvents(ALL, ALL), 3);
  assert.equal(await store.oldestStreamId(server, channel), undefined);
});

test("the retention timer prunes at startup and on each interval, logs the count, and stops", async t => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => { logged.push(line); });
  const calls: [number, number][] = [];
  const store = { async pruneConversationEvents(olderThan: number, maxRows: number) { calls.push([olderThan, maxRows]); return 7; } };
  const stop = startConversationEventRetention(store, { days: 14, maxRows: 99 }, 5);
  await new Promise(resolve => setTimeout(resolve, 30));
  stop();
  const count = calls.length;
  assert.ok(count >= 2, `expected startup and interval runs, got ${count}`);
  assert.equal(calls[0]![1], 99);
  assert.ok(Math.abs(calls[0]![0] - (Date.now() - 14 * 86_400_000)) < 60_000);
  assert.deepEqual(JSON.parse(logged[0]!), { type: "conversation_events_pruned", deleted: 7, retentionDays: 14, maxRows: 99 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, count);
});

test("a failing prune is logged and the timer keeps going", async t => {
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => { errors.push(line); });
  let attempts = 0;
  const store = { async pruneConversationEvents() { attempts++; throw new Error("disk full"); } };
  const stop = startConversationEventRetention(store, { days: 1, maxRows: 1 }, 5);
  await new Promise(resolve => setTimeout(resolve, 30));
  stop();
  assert.ok(attempts >= 2);
  assert.ok(errors.every(line => line.includes("conversation_events_prune_failed")));
  assert.ok(errors.length >= 2);
});
