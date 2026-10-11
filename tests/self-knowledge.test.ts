import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry, toolResult } from "../src/tools.js";
import { selfKnowledgeTool } from "../src/self-knowledge.js";

test("self knowledge works for members, ships focused topics and rejects arbitrary file reads", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  let runtime = "Reply model: example";
  registry.register(selfKnowledgeTool(registry, () => runtime));
  const message = { id: "m", server: "s", channel: "c", author: "a", text: "How do you work?" };
  for (const topic of registry.definitions()[0]!.fields.topic!.choices!) {
    const result = toolResult(await registry.invoke(message, "bot_info", { topic }, `topic:${topic}`, "agent"));
    assert.ok(result.text.length > 0 && result.text.length <= 2000, topic);
    assert.ok(!result.text.includes("DISCORD_BOT_TOKEN"));
  }
  const capabilities = toolResult(await registry.invoke(message, "bot_info", { topic: "capabilities" }, "caps", "command"));
  assert.match(capabilities.text, /bot_info \(member, read\)/);
  runtime = "Reply model: changed";
  assert.match(toolResult(await registry.invoke(message, "bot_info", { topic: "runtime" }, "runtime2", "agent")).text, /changed/);
  await assert.rejects(registry.invoke(message, "bot_info", { topic: "../../.env" }, "bad", "agent"));
});
