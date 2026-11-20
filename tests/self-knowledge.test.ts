import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ContextBuilder } from "../src/context-builder.js";
import type { Message } from "../src/domain.js";
import { INCOGNITO_SERVER, incognitoChannel } from "../src/personal.js";
import { directMessageChannel, privateChannel } from "../src/private-chat.js";
import { ToolRegistry, toolResult, type ToolExecutor } from "../src/tools.js";
import { selfKnowledgeTool } from "../src/self-knowledge.js";

test("request context names the surface the message came from", async () => {
  const tools = { schemas: () => [], catalog: () => "", execute: async () => { throw new Error("not used"); } } as ToolExecutor;
  const builder = new ContextBuilder({
    store: { contextVersion: async () => "1", context: async () => [] } as never,
    tools,
    counter: { name: "test", count: () => 1 },
    inputLimit: 1e6,
    outputLimit: 1000,
    prefix: [],
  });
  const message = (channel: string, surface: Message["surface"], server = "s") => ({ id: "m", server, channel, author: "alice", authorName: "Alice", text: "hi", timestamp: 1_000, addressed: true, surface }) as Message;
  const cases: [Message, string][] = [
    [message("100000000000000001", "discord"), "discord_channel"],
    [message(directMessageChannel("200000000000000002"), "discord-dm"), "discord_dm"],
    [message(privateChannel("0123456789abcdef0123456789abcdef"), "web"), "web_chat"],
    [message(incognitoChannel("0123456789abcdef0123456789abcdef"), "web-incognito", INCOGNITO_SERVER), "private_web_chat"],
  ];
  for (const [request, surface] of cases) {
    const built = await builder.build(request, undefined, 0, async () => []);
    const content = built.inputs.find(item => item.contextOnly)!.content;
    assert.match(content, new RegExp(`^surface: ${surface}$`, "m"), surface);
  }
});

test("self knowledge works for members, ships focused topics and rejects arbitrary file reads", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  let runtime = "Reply model: example";
  registry.register(selfKnowledgeTool(registry, async user => user === "team", () => runtime));
  const message = { id: "m", server: "s", channel: "c", author: "a", text: "How do you work?" };
  const teamMessage = { ...message, id: "t", author: "team" };
  for (const topic of registry.definitions()[0]!.fields.topic!.choices!) {
    const internal = topic === "decision_prompt" || topic === "participation_prompt";
    if (internal) await assert.rejects(registry.invoke(message, "bot_info", { topic }, `member:${topic}`, "agent"), /Slopbot team/);
    const result = toolResult(await registry.invoke(internal ? teamMessage : message, "bot_info", { topic }, `topic:${topic}`, "agent"));
    assert.ok(result.text.length > 0 && result.text.length <= 2000, topic);
    assert.ok(!result.text.includes("DISCORD_BOT_TOKEN"));
  }
  const capabilities = toolResult(await registry.invoke(message, "bot_info", { topic: "capabilities" }, "caps", "command"));
  assert.match(capabilities.text, /bot_info \(member, read\)/);
  runtime = "Reply model: changed";
  assert.match(toolResult(await registry.invoke(message, "bot_info", { topic: "runtime" }, "runtime2", "agent")).text, /changed/);
  await assert.rejects(registry.invoke(message, "bot_info", { topic: "../../.env" }, "bad", "agent"));
});

