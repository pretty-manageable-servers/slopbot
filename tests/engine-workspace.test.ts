import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { loadConfig } from "../src/config.js";
import type { ChatGateway } from "../src/bot.js";
import type { Message } from "../src/domain.js";
import { WorkspaceEngine } from "../src/engine/engine.js";
import type { WorkspacePorts } from "../src/engine/ports.js";
import { EngineWorkspace } from "../src/engine/workspace.js";
import { createUsageMeter } from "../src/usage-meter.js";
import { ChannelAccess } from "../src/channel-access.js";

const server = "1528063444874432734", channel = "1528064977913647236";

/** A workspace with no chat platform: every port is a fake that records what the engine sends out. */
function fixture() {
  const config = loadConfig({ DISCORD_BOT_TOKEN: "test-only", DISCORD_GUILD_ID: server, DISCORD_CHANNEL_IDS: channel, LLM_MODE: "mock" });
  const store = new SQLiteStore();
  const replies: string[] = [];
  const gateway: ChatGateway = {
    reply: async (message, text) => { replies.push(text); return [{ ...message, id: `reply:${message.id}`, text, author: "bot" }]; },
    createTaskThread: async () => "thread",
    typing: () => () => {},
  };
  const unused = async (): Promise<never> => { throw new Error("The platform is not available in this test"); };
  const ports: WorkspacePorts = {
    directory: { canManage: async () => false },
    gateway,
    validateChannel: async () => {},
    reply: async (message, text) => { replies.push(text); void message; },
    typing: () => () => {},
    findChannels: unused, taskThread: async () => undefined, fetchHistory: async () => [], fetchMessage: unused,
    imageAttachments: async () => undefined, sendStoredFile: unused, reminderChannel: () => undefined,
    registerTools: () => {},
  };
  const llm = { async *stream() { yield { kind: "text" as const, payload: { text: "Hello from the engine." } }; } };
  const workspace = new EngineWorkspace(config, store, llm, server, undefined, createUsageMeter(config, store), new ChannelAccess({ facts: async () => undefined }), undefined, undefined, undefined, ports);
  return { workspace, store, replies };
}

test("a workspace answers a message with no platform client", async t => {
  const f = fixture();
  t.after(async () => { await f.workspace.worker.stop(); f.store.close(); });
  const message: Message = { id: "m1", server, channel, author: "person", text: "hello", addressed: true, timestamp: Date.now() };
  f.workspace.worker.start();
  await f.workspace.submit(message);
  await f.workspace.worker.idle();
  assert.deepEqual(f.replies, ["Hello from the engine."]);
});

test("the engine returns the workspace of an open server and forgets a failed one", async () => {
  const engine = new WorkspaceEngine();
  const f = fixture();
  engine.add(server, Promise.resolve(f.workspace));
  assert.equal(await engine.workspace(server), f.workspace);
  engine.add("failed", Promise.reject(new Error("no")));
  assert.equal(await engine.workspace("failed"), undefined);
  engine.remove(server);
  assert.equal(await engine.workspace(server), undefined);
  f.store.close();
});
