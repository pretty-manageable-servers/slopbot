import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry, toolResult } from "../src/tools.js";
import { selfKnowledgeTool } from "../src/self-knowledge.js";

test("self knowledge works for members, ships focused topics and rejects arbitrary file reads", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  const runtime = "Reply model: example";
  registry.register(selfKnowledgeTool(registry, async user => user === "team", () => runtime));
  const message = { id: "m", server: "s", channel: "c", author: "a", text: "How do you work?" };
  const teamMessage = { ...message, id: "t", author: "team" };
  for (const topic of registry.definitions()[0]!.fields.topic!.choices!) {
    const internal = topic === "decision_prompt" || topic === "participation_prompt";
    if (internal) await assert.rejects(registry.invoke(message, "bot_info", { topic }, `member:${topic}`, "agent"), /Slopbot team/);
    const result = toolResult(await registry.invoke(internal ? teamMessage : message, "bot_info", { topic }, `topic:${topic}`, "agent"));
    assert.ok(result.text.length > 0, topic);
    assert.ok(!result.text.includes("DISCORD_BOT_TOKEN"));
  }
  await assert.rejects(registry.invoke(message, "bot_info", { topic: "../../.env" }, "bad", "agent"));
});
