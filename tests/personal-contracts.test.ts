import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryList } from "@slopbot/contracts";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { WebChatRow } from "../src/clients/web/web-chat-store.js";
import { ToolError } from "../src/errors.js";
import type { Message } from "../src/domain.js";
import { surfaceOf } from "../src/engine/api.js";
import { PERSONAL_SERVER, incognitoChannel } from "../src/personal.js";
import { directMessageChannel, isDirectMessageChannel, isPrivateChannel, privateChannel } from "../src/private-chat.js";
import { PROJECT_MEMORY_SERVER, memoryScope, memoryScopes } from "../src/projects.js";

const chat = "0123456789abcdef0123456789abcdef";
const incognito = incognitoChannel(chat);
const dm = directMessageChannel("100000000000000001");

function message(id: string, timestamp: number, replyTo?: string): Message {
  return { id, server: "s", channel: privateChannel(chat), author: "alice", text: id, timestamp, ...(replyTo ? { replyTo } : {}) };
}

function webChatRow(id: string): WebChatRow {
  return { id, server: "s", owner: "alice", title: "", created: 1, updated: 1, deleted: false, storageServer: null, titleSource: "auto" };
}

test("surfaceOf gives web-incognito for an incognito channel", () => {
  assert.equal(surfaceOf({ channel: incognito }), "web-incognito");
  assert.equal(surfaceOf({ channel: incognito, surface: "web" }), "web-incognito");
});

test("an incognito channel is private but not a DM", () => {
  assert.equal(isPrivateChannel(incognito), true);
  assert.equal(isDirectMessageChannel(incognito), false);
});

test("memoryScopes for project, web, dm, incognito, server", () => {
  const project = "a".repeat(32);
  assert.deepEqual(memoryScopes({ server: PERSONAL_SERVER, channel: privateChannel(chat), project, author: "alice", surface: "web" }), [
    { server: PROJECT_MEMORY_SERVER, channel: `project:${project}` },
    { server: PERSONAL_SERVER, channel: "user:alice" },
  ]);
  // A web chat reads its personal scope and its own channel (the legacy scope, until WP3).
  assert.deepEqual(memoryScopes({ server: PERSONAL_SERVER, channel: privateChannel(chat), author: "alice", surface: "web" }), [{ server: PERSONAL_SERVER, channel: "user:alice" }, { server: PERSONAL_SERVER, channel: privateChannel(chat) }]);
  // A message saved before surface existed gets its surface from the channel.
  assert.deepEqual(memoryScopes({ server: PERSONAL_SERVER, channel: privateChannel(chat), author: "alice" }), [{ server: PERSONAL_SERVER, channel: "user:alice" }, { server: PERSONAL_SERVER, channel: privateChannel(chat) }]);
  assert.deepEqual(memoryScopes({ server: PERSONAL_SERVER, channel: dm, author: "alice", surface: "discord-dm" }), [{ server: PERSONAL_SERVER, channel: "user:alice" }, { server: PERSONAL_SERVER, channel: dm }]);
  assert.deepEqual(memoryScopes({ server: PERSONAL_SERVER, channel: incognito, author: "alice", surface: "web-incognito" }), []);
  assert.deepEqual(memoryScopes({ server: "guild", channel: "100000000000000002", author: "alice" }), [{ server: "guild", channel: "100000000000000002" }]);
});

test("memoryScope throws in a private chat", () => {
  assert.throws(() => memoryScope({ server: PERSONAL_SERVER, channel: incognito, author: "alice", surface: "web-incognito" }), ToolError);
});

test("contextSince returns all messages after the time", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const m0 = message("m0", 50), m1 = message("m1", 100), m2 = message("m2", 200, "m0"), m3 = message("m3", 300);
  for (const item of [m0, m1, m2, m3]) await store.ingest(item);
  assert.deepEqual((await store.contextSince(m3, undefined)).map(item => item.id), ["m0", "m1", "m2", "m3"]);
  // m0 is before the time, but m2 replies to it, so it is kept.
  assert.deepEqual((await store.contextSince(m3, 150)).map(item => item.id), ["m0", "m2", "m3"]);
  // No count cap: 30 messages after the time all come back.
  for (let index = 0; index < 30; index++) await store.ingest(message(`l${index}`, 400 + index));
  assert.equal((await store.contextSince(m3, 350)).length, 30);
});

test("summary round trip", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  assert.equal(await store.webChatSummary(chat), undefined);
  await store.saveWebChatSummary(chat, { throughMessage: "m1", throughTimestamp: 100, summary: "first", runId: "r1" });
  await store.saveWebChatSummary(chat, { throughMessage: "m2", throughTimestamp: 200, summary: "second", runId: "r2" });
  assert.deepEqual(await store.webChatSummary(chat), { throughMessage: "m2", throughTimestamp: 200, summary: "second" });
});

test("title_source defaults to auto", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.insertWebChat(webChatRow(chat));
  const found = await store.webChat(chat);
  assert.equal(found?.titleSource, "auto");
  assert.equal(found?.storageServer, null);
});

test("setWebChatTitle sets the source", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.insertWebChat(webChatRow(chat));
  await store.setWebChatTitle(chat, "Model title", "model", 5);
  assert.deepEqual(await store.webChat(chat).then(row => [row?.title, row?.titleSource]), ["Model title", "model"]);
  await store.setWebChatTitle(chat, "My title", "user", 6);
  assert.deepEqual(await store.webChat(chat).then(row => [row?.title, row?.titleSource]), ["My title", "user"]);
});

test("MemoryList parses", () => {
  const list = MemoryList.parse({ items: [{ id: "m1", content: "likes tea", category: "preference", tags: [], scope: "personal", updated: 1700000000000 }], total: 1 });
  assert.equal(list.items[0]?.scope, "personal");
  assert.throws(() => MemoryList.parse({ items: [], total: -1 }));
});
