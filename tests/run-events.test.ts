import assert from "node:assert/strict";
import { test } from "node:test";
import { EventJournal } from "../src/event-journal.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { engineEvents } from "../src/engine/event-log.js";
import { publishMessage, publishMessageDelete } from "../src/run-events.js";
import { webTranscriptKey } from "../src/server-tools.js";
import type { Message } from "../src/domain.js";

const server = "1528063444874432734", channel = "1528063444874432735", bot = "1528063444874432799";
const user = "1514413259522838529";

function setup(t: { after(fn: () => void): void }) {
  const store = new SQLiteStore(":memory:");
  engineEvents.attach(store);
  t.after(() => { engineEvents.attach(undefined as never); store.close(); });
  store.setSetting(server, webTranscriptKey(channel), true);
  return store;
}
const message = (id: string, text = "hello", extra: Partial<Message> = {}): Message => ({
  id, server, channel, author: user, authorName: "Ada", text, timestamp: 1_000 + Number(id.slice(-3)), ...extra,
});
const saved = (store: SQLiteStore) => store.engineEventsAfter(server, channel, 0, 1000);

test("only a model round is published, not a checkpoint run", async t => {
  const store = setup(t);
  const request = message("req-1", "why?");
  await store.startRun("run-check", request, { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" });
  const checkpoint = new EventJournal(store, "run-check", request, "checkpoint model");
  await checkpoint.append({ kind: "text", payload: { text: "summary" } });
  await checkpoint.close();
  const journal = new EventJournal(store, "run-reply", request, "model");
  await journal.append({ kind: "text", payload: { text: "Because reasons." } });
  await journal.close();
  await engineEvents.idle();
  assert.deepEqual((await saved(store)).map(item => item.event.type), ["round.start", "text.delta"]);
});

test("messages carry the Slopbot flag and run IDs, and deletes publish", async t => {
  const store = setup(t);
  store.setSetting(server, "context_bot_author", bot);
  await store.startRun("run-x", message("req-2"), { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" });
  const reply: Message = { id: "reply-1", server, channel, author: bot, authorName: "Slopbot", text: "Answer", timestamp: 2_000, isBot: true };
  await publishMessage(store, reply, ["run-x"]);
  await publishMessage(store, message("user-1", "Hi there", { timestamp: 1_500 }));
  publishMessageDelete(server, channel, "user-1");
  await engineEvents.idle();
  const events = (await saved(store)).map(item => item.event);
  const [first, second, third] = events;
  assert.ok(first?.type === "message.upsert" && second?.type === "message.upsert");
  assert.deepEqual([first.message.slopbot, first.message.runIds], [true, ["run-x"]]);
  assert.deepEqual([second.message.slopbot, second.message.runIds], [false, []]);
  assert.deepEqual(third, { type: "message.delete", id: "user-1" });
});
