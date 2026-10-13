import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry, ToolError, type ToolDefinition } from "../src/tools.js";
import { isPrivateChannel, privateChannel, privateChatTitle } from "../src/private-chat.js";
import { transcriptSwitchOn } from "../src/server-tools.js";
import type { Message } from "../src/domain.js";

const privateId = "0123456789abcdef0123456789abcdef";
const privateMessage: Message = { id: "m1", server: "s", channel: privateChannel(privateId), author: "alice", text: "hi" };
const discordMessage: Message = { id: "m2", server: "s", channel: "100000000000000001", author: "alice", text: "hi" };

function registry(store: SQLiteStore) {
  const tools = new ToolRegistry(store, async () => false);
  const reader: ToolDefinition = { name: "reader", description: "reads", fields: {}, access: "member", effect: "read", retrySafe: true, async execute() { return "read ok"; } };
  const writer: ToolDefinition = { name: "writer", description: "writes", fields: {}, access: "member", effect: "write", retrySafe: false, async execute() { return "wrote"; } };
  tools.register(reader);
  tools.register(writer);
  return tools;
}

test("private channel IDs are recognised by their prefix only", () => {
  assert.equal(isPrivateChannel(privateChannel(privateId)), true);
  assert.equal(isPrivateChannel("100000000000000001"), false);
  assert.equal(privateChatTitle("  hello\n  there  "), "hello there");
  assert.equal(privateChatTitle("x".repeat(100)).length, 60);
});

test("a private chat is offered read-only tools only", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const tools = registry(store);
  assert.deepEqual(tools.schemas(privateMessage).map(item => item.function.name), ["reader"]);
  assert.doesNotMatch(tools.catalog(privateMessage), /"writer"/);
  assert.deepEqual(tools.schemas(discordMessage).map(item => item.function.name), ["reader", "writer"]);
  assert.deepEqual(tools.schemas().map(item => item.function.name), ["reader", "writer"]);
});

test("a private chat cannot run a write tool, even when asked directly", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const tools = registry(store);
  await assert.rejects(tools.invokeResult(privateMessage, "writer", {}, "op-private-write", "agent"), (error: unknown) => error instanceof ToolError && /private chats/.test(error.message));
  assert.equal((await tools.invokeResult(privateMessage, "reader", {}, "op-private-read", "agent")).text, "read ok");
  assert.equal((await tools.invokeResult(discordMessage, "writer", {}, "op-discord-write", "agent")).text, "wrote");
});

test("a private chat has its transcript switch on, a Discord channel does not", t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  assert.equal(transcriptSwitchOn(store, "s", privateChannel(privateId)), true);
  assert.equal(transcriptSwitchOn(store, "s", "100000000000000001"), false);
});

const chatRow = (id: string, owner = "alice") => ({ id, server: "s", owner, title: "", created: 1, updated: 1, deleted: false });

test("a web chat row is saved, listed by owner and renamed", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.insertWebChat(chatRow(privateId));
  await store.insertWebChat(chatRow("f".repeat(32), "bob"));
  assert.deepEqual((await store.webChats("s", "alice")).map(row => row.id), [privateId]);
  await store.renameWebChat(privateId, "Dinner plans", 5);
  assert.equal((await store.webChat(privateId))?.title, "Dinner plans");
  assert.deepEqual(await store.liveWebChatChannels("s"), [privateChannel(privateId), privateChannel("f".repeat(32))]);
});

test("the Discord purge keeps private chat messages and queued jobs", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.insertWebChat(chatRow(privateId));
  const chat = privateChannel(privateId);
  await store.ingest({ id: "web-1", server: "s", channel: chat, author: "alice", text: "private", addressed: true, source: "web" });
  await store.ingest({ id: "old-1", server: "s", channel: "100000000000000009", author: "alice", text: "old channel" });
  await store.purgeUnconfigured("s", ["100000000000000001"]);
  assert.ok(await store.canonicalMessage("s", "web-1"), "private message must survive the purge");
  assert.equal(await store.canonicalMessage("s", "old-1"), undefined, "unconfigured Discord message is still purged");
});

test("deleting a private chat removes its messages, runs and events and keeps other chats", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.insertWebChat(chatRow(privateId));
  const chat = privateChannel(privateId);
  const other = privateChannel("e".repeat(32));
  await store.insertWebChat(chatRow("e".repeat(32)));
  const message = { id: "web-2", server: "s", channel: chat, author: "alice", text: "keep me out", addressed: true, source: "web" as const };
  await store.ingest(message);
  await store.ingest({ ...message, id: "web-other", channel: other, text: "other chat" });
  await store.startRun("run-private", message, { prefixVersion: "test", prefix: [], history: [], inputs: [] });
  await store.appendEvent("run-private", 0, { kind: "text", payload: { text: "secret answer" } });
  await store.appendConversationEvent({ server: "s", channel: chat, kind: "message", ref: "web-2", data: {}, createdAt: 1 });
  await store.deleteWebChat(privateId, "s", chat, 9);
  assert.equal(await store.canonicalMessage("s", "web-2"), undefined);
  assert.deepEqual(store.events("run-private"), []);
  assert.equal(await store.latestStreamId("s", chat), 0);
  assert.equal((await store.webChat(privateId))?.deleted, true);
  assert.deepEqual((await store.webChats("s", "alice")).map(row => row.id), ["e".repeat(32)]);
  assert.ok(await store.canonicalMessage("s", "web-other"), "other chats are untouched");
});
