import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ChannelAccess } from "../src/channel-access.js";
import { loadConfig } from "../src/config.js";
import type { Message } from "../src/domain.js";
import type { Directory } from "../src/engine/api.js";
import { LocalServer } from "../src/local/local-server.js";
import { LOCAL_ONLY } from "../src/local/world.js";
import { privateChannel } from "../src/private-chat.js";
import { createUsageMeter } from "../src/usage-meter.js";

const server = "1528063444874432734", member = "1528063444874432735", chat = privateChannel("abc");

function fixture() {
  const config = loadConfig({ DISCORD_BOT_TOKEN: "test-only", DISCORD_GUILD_ID: server, LLM_MODE: "mock" });
  const store = new SQLiteStore();
  const llm = { async *stream() { yield { kind: "text" as const, payload: { text: "Hello from the engine." } }; } };
  const directory = { isMember: async (user: string) => user === member, canManage: async () => false } as unknown as Directory;
  const local = new LocalServer({
    config, store, llm, server, usage: createUsageMeter(config, store), access: new ChannelAccess({ facts: async () => undefined }),
    team: { canEdit: async () => false } as never, directory,
  });
  const message = (channel: string, author = member): Message => ({ id: "m1", server, channel, author, text: "hello", addressed: true, timestamp: Date.now() });
  return { local, store, message };
}

test("a private chat message gets a reply through the WebChatGateway", async t => {
  const f = fixture();
  t.after(async () => { await f.local.stop(); f.store.close(); });
  await f.local.ready("bot");
  f.local.workspace.openChat(chat);
  await f.local.workspace.submit(f.message(chat));
  await f.local.workspace.worker.idle();
  const saved = (await f.store.recentChannelMessages(server, chat, 10)).map(m => m.text);
  assert.ok(saved.includes("Hello from the engine."), JSON.stringify(saved));
});

test("validateChannel refuses a non-private channel", async t => {
  const f = fixture();
  t.after(async () => { await f.local.stop(); f.store.close(); });
  await assert.rejects(f.local.ports.validateChannel(f.message("123456"), "123456"), { message: LOCAL_ONLY });
  await assert.rejects(f.local.ports.validateChannel(f.message(chat, "stranger"), chat), { message: LOCAL_ONLY });
  await f.local.ports.validateChannel(f.message(chat), chat);
});

test("stop ends the worker and timers", async () => {
  const f = fixture();
  await f.local.ready("bot");
  await f.local.stop();
  f.store.close();
});
