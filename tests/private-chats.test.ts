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
  const reader: ToolDefinition = { name: "reader", surface: "top", description: "reads", fields: {}, access: "member", effect: "read", retrySafe: true, async execute() { return "read ok"; } };
  // Like the shell tool: a write that does not act on Discord.
  const writer: ToolDefinition = { name: "writer", surface: "top", description: "writes", fields: {}, access: "member", effect: "write", retrySafe: false, async execute() { return "wrote"; } };
  const poster: ToolDefinition = { name: "poster", surface: "top", description: "posts to Discord", fields: {}, access: "member", effect: "write", retrySafe: false, scope: "discord", async execute() { return "posted"; } };
  tools.register(reader);
  tools.register(writer);
  tools.register(poster);
  return tools;
}

test("private channel IDs are recognised by their prefix only", () => {
  assert.equal(isPrivateChannel(privateChannel(privateId)), true);
  assert.equal(isPrivateChannel("100000000000000001"), false);
  assert.equal(privateChatTitle("  hello\n  there  "), "hello there");
  assert.equal(privateChatTitle("x".repeat(100)).length, 60);
});

test("a private chat is offered every tool except Discord-scoped ones", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const tools = registry(store);
  assert.deepEqual(tools.schemas(privateMessage).map(item => item.function.name), ["reader", "writer"]);
  assert.doesNotMatch(tools.catalog(privateMessage), /"poster"/);
  assert.match(tools.catalog(privateMessage), /"writer"/);
  assert.deepEqual(tools.schemas(discordMessage).map(item => item.function.name), ["poster", "reader", "writer"]);
  assert.deepEqual(tools.schemas().map(item => item.function.name), ["poster", "reader", "writer"]);
});

test("a private chat runs a write tool, but a Discord-scoped call throws", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const tools = registry(store);
  await assert.rejects(tools.invokeResult(privateMessage, "poster", {}, "op-private-post", "agent"), (error: unknown) => error instanceof ToolError && error.message === "This action is only available in Discord.");
  assert.equal((await tools.invokeResult(privateMessage, "writer", {}, "op-private-write", "agent")).text, "wrote");
  assert.equal((await tools.invokeResult(privateMessage, "reader", {}, "op-private-read", "agent")).text, "read ok");
  assert.equal((await tools.invokeResult(discordMessage, "poster", {}, "op-discord-post", "agent")).text, "posted");
});

test("a private chat is never forced into a Discord-scoped call", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const tools = registry(store);
  const lookup: ToolDefinition = { name: "lookup", description: "reads Discord state", fields: {}, access: "member", effect: "read", retrySafe: true, scope: "discord", matchRead: () => ({}), async execute() { return "looked"; } };
  tools.register(lookup);
  assert.equal(tools.suggest({ ...privateMessage, text: "look it up" }), undefined);
  assert.deepEqual(tools.suggest({ ...discordMessage, text: "look it up" }), { name: "lookup", arguments: {} });
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
  assert.deepEqual((await store.webChats("alice")).map(row => row.id), [privateId]);
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
  assert.deepEqual((await store.webChats("alice")).map(row => row.id), ["e".repeat(32)]);
  assert.ok(await store.canonicalMessage("s", "web-other"), "other chats are untouched");
});

import { Application } from "../src/application.js";
import { Bot, type ChatGateway, type Incoming } from "../src/bot.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { WebChatGateway } from "../src/web-chats.js";
import type { ToolActivity } from "../src/tool-activity.js";

function botFor(store: SQLiteStore, tools?: ToolRegistry) {
  const app = new Application(store, new FakeLLM(), { allowedChannels: [{ server: "s", channel: "100000000000000001" }] });
  const outputs: { channel: string; text: string }[] = [];
  let created = 0;
  const gateway: ChatGateway = {
    async reply(message, text) {
      outputs.push({ channel: message.channel, text });
      return [{ id: `out:${outputs.length}`, server: "s", channel: message.channel, author: "bot", text }];
    },
    async createTaskThread() { created++; return "thread"; },
    typing() { return () => undefined; },
  };
  const bot = new Bot(app, store, store, gateway, "s", ["100000000000000001"], { knowledge: store, ...(tools ? { tools } : {}) });
  return { bot, outputs, created: () => created };
}

const privateIncoming = (id: string, text: string, chat = privateChannel(privateId)): Incoming => ({
  id, server: "s", channel: chat, author: "alice", text, addressed: true, source: "web", botAuthor: false, mentionsBot: false, repliesToBot: false,
});

test("a private chat is accepted only after it is opened, and only in its own server", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const { bot } = botFor(store);
  assert.equal(bot.accepts("s", privateChannel(privateId)), false);
  bot.openPrivateChat("s", privateChannel(privateId));
  assert.equal(bot.accepts("s", privateChannel(privateId)), true);
  assert.equal(bot.accepts("other", privateChannel(privateId)), false);
  bot.closePrivateChat("s", privateChannel(privateId));
  assert.equal(bot.accepts("s", privateChannel(privateId)), false);
  assert.throws(() => bot.openPrivateChat("s", "100000000000000001"), /Not a private chat/);
});

test("a private chat gets an answer from the bot, with the message saved once", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const { bot, outputs } = botFor(store);
  bot.openPrivateChat("s", privateChannel(privateId));
  const message = privateIncoming("web-1", "hello there");
  await store.ingest(message);
  await bot.receive(message, { ingested: true });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]!.channel, privateChannel(privateId));
});

test("a private chat saves memories, but cannot start tasks", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const { bot, outputs, created } = botFor(store);
  bot.openPrivateChat("s", privateChannel(privateId));
  await bot.receive(privateIncoming("web-2", "!remember I like tea"));
  await bot.receive(privateIncoming("web-3", "!task plan a trip"));
  assert.equal(created(), 0, "no task thread may be created");
  assert.deepEqual((await store.memories("s", privateChannel(privateId))).map(note => note.content), ["I like tea"]);
  assert.equal(outputs.at(-1)!.text, "This action is only available in Discord.");
});

test("a private chat runs a write tool through the bot, but a Discord-scoped one is refused", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const tools = registry(store);
  const { bot, created } = botFor(store, tools);
  bot.openPrivateChat("s", privateChannel(privateId));
  assert.equal((await bot.executeTool(privateMessage, { name: "writer", arguments: {} }, "op-bot-write")).text, "wrote");
  assert.equal(created(), 0, "a private write never starts a task thread");
  await assert.rejects(bot.executeTool(privateMessage, { name: "poster", arguments: {} }, "op-bot-post"), (error: unknown) => error instanceof ToolError && error.message === "This action is only available in Discord.");
  assert.equal(created(), 0);
});

test("a private chat reply has no tool footer, because the web run summary shows the tools", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const gateway = new WebChatGateway(store, "s");
  const activity: ToolActivity[] = [{ id: "t1", name: "status", status: "completed" }];
  const [reply] = await gateway.reply(privateMessage, "Answer", "delivery-1", activity);
  assert.equal(reply!.text, "Answer");
});

test("the chat list of an owner has the chats of all servers", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.insertWebChat({ id: "a".repeat(32), server: "s1", owner: "alice", title: "one", created: 1, updated: 1, deleted: false });
  await store.insertWebChat({ id: "b".repeat(32), server: "s2", owner: "alice", title: "two", created: 2, updated: 2, deleted: false });
  await store.insertWebChat({ id: "c".repeat(32), server: "s1", owner: "bob", title: "not hers", created: 3, updated: 3, deleted: false });
  assert.deepEqual((await store.webChats("alice")).map(row => row.id), ["b".repeat(32), "a".repeat(32)]);
});
