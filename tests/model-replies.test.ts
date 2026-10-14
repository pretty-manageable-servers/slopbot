import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Message } from "../src/domain.js";

const SERVER = "1528063444874432734";
const prompt = { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" as const };

function msg(id: string, extra: Partial<Message> = {}): Message {
  return { id, server: SERVER, channel: "1528063444874432735", author: "user-ada", authorName: "Ada", text: id, timestamp: 1000, ...extra };
}

test("returns completed run text", async t => {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  const request = msg("req-1");
  await store.ingest(request);
  await store.startRun("run-ok", request, prompt);
  await store.complete("run-ok", undefined, [], "Done.");
  const sent = msg("bot-1", { author: "bot-user", isBot: true, text: "Discord copy" });
  await store.ingest(sent);
  await store.linkOutput(sent, "run-ok", request.id);
  assert.deepEqual(await store.modelReplies(SERVER, ["bot-1", "unknown"]), new Map([["bot-1", { runId: "run-ok", text: "Done." }]]));
});

test("ignores failed run", async t => {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  const request = msg("req-2");
  await store.ingest(request);
  await store.startRun("run-bad", request, prompt);
  await store.fail("run-bad", "boom");
  const sent = msg("bot-2", { author: "bot-user", isBot: true, text: "Error" });
  await store.ingest(sent);
  await store.linkOutput(sent, "run-bad", request.id);
  assert.equal((await store.modelReplies(SERVER, ["bot-2"])).size, 0);
});

test("latest completed run wins", async t => {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  const request = msg("req-3");
  await store.ingest(request);
  await store.startRun("run-a", request, prompt);
  await store.complete("run-a", undefined, [], "First run.");
  await store.startRun("run-b", request, prompt);
  await store.complete("run-b", undefined, [], "Second run.");
  const sent = msg("bot-3", { author: "bot-user", isBot: true, text: "Discord copy" });
  await store.ingest(sent);
  await store.linkOutput(sent, "run-a", request.id);
  await store.linkOutput(sent, "run-b", request.id);
  assert.deepEqual(await store.modelReplies(SERVER, ["bot-3"]), new Map([["bot-3", { runId: "run-b", text: "Second run." }]]));
});

test("empty input", async t => {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  assert.equal((await store.modelReplies(SERVER, [])).size, 0);
});
