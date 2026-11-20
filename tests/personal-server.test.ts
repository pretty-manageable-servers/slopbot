import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ChannelAccess } from "../src/channel-access.js";
import { loadConfig } from "../src/config.js";
import type { Message } from "../src/domain.js";
import type { Directory } from "../src/engine/api.js";
import { PERSONAL_SERVER } from "../src/personal.js";
import { PersonalServer } from "../src/personal-server.js";
import { privateChannel } from "../src/private-chat.js";
import { createUsageMeter } from "../src/usage-meter.js";

const user = "1528063444874432735", chat = privateChannel("abc");

function fixture() {
  const config = loadConfig({ DISCORD_BOT_TOKEN: "test-only", LLM_MODE: "mock" });
  const store = new SQLiteStore();
  const llm = { async *stream() { yield { kind: "text" as const, payload: { text: "Hello from the engine." } }; } };
  const directory = { isMember: async () => false, canManage: async () => false } as unknown as Directory;
  const personal = new PersonalServer({
    config, store, llm, usage: createUsageMeter(config, store), access: new ChannelAccess({ facts: async () => undefined }),
    team: { canEdit: async () => false } as never, directory,
  });
  const message = (channel: string, author = user): Message => ({ id: "m1", server: PERSONAL_SERVER, channel, author, text: "hello", addressed: true, timestamp: Date.now() });
  return { personal, store, message };
}

test("a chat message in the personal workspace gets a reply, with no server membership", async t => {
  const f = fixture();
  t.after(async () => { await f.personal.stop(); f.store.close(); });
  await f.personal.ready("bot");
  f.personal.workspace.openChat(chat);
  await f.personal.workspace.submit(f.message(chat));
  await f.personal.workspace.worker.idle();
  const saved = (await f.store.recentChannelMessages(PERSONAL_SERVER, chat, 10)).map(m => m.text);
  assert.ok(saved.includes("Hello from the engine."), JSON.stringify(saved));
});

test("ready reopens the live personal chats", async t => {
  const f = fixture();
  t.after(async () => { await f.personal.stop(); f.store.close(); });
  await f.store.insertWebChat({ id: "abc", server: PERSONAL_SERVER, owner: user, title: "", created: 1, updated: 1, deleted: false, storageServer: null, titleSource: "auto" });
  await f.personal.ready("bot");
  await f.personal.workspace.submit(f.message(chat));
  await f.personal.workspace.worker.idle();
  const saved = (await f.store.recentChannelMessages(PERSONAL_SERVER, chat, 10)).map(m => m.text);
  assert.ok(saved.includes("Hello from the engine."), JSON.stringify(saved));
});

test("validateChannel allows only the message's own private channel", async t => {
  const f = fixture();
  t.after(() => f.store.close());
  await f.personal.ports.validateChannel(f.message(chat), chat);
  await assert.rejects(f.personal.ports.validateChannel(f.message(chat), privateChannel("other")));
  await assert.rejects(f.personal.ports.validateChannel(f.message("123456"), "123456"));
});

test("a dm channel without dm ports gives a ToolError", async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const dm = f.message("web:dm:555");
  await assert.rejects(f.personal.ports.reply(dm, "hi"), { name: "ToolError", message: "DMs are not available here." });
  await assert.rejects(async () => f.personal.ports.fetchHistory("web:dm:555", null, 5), { message: "DMs are not available here." });
  assert.throws(() => f.personal.ports.typing("web:dm:555"), { message: "DMs are not available here." });
});
