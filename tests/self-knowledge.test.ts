import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry, toolResult } from "../src/tools.js";
import { selfKnowledgeTool } from "../src/self-knowledge.js";

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


test("bot_info documents native calling, budgets and the current provider changelog with source links", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registry.register(selfKnowledgeTool(registry, async user => user === 'team', () => 'Native function calling: enabled'));
  const message = {id:'m',server:'s',channel:'c',author:'a',text:'Explain the deployment'};
  const tools = await registry.invokeResult(message,'bot_info',{topic:'tools'},'native','agent');
  assert.match(tools.text,/native function schemas/); assert.match(tools.text,/64/);
  const changes = await registry.invokeResult(message,'bot_info',{topic:'pmservers_changelog'},'changes','agent');
  assert.match(changes.text,/2026-10-11/); assert.match(changes.text,/2026-11-10/);
  assert.ok(changes.sources?.some(source=>source.kind==='web' && source.url==='https://docs.pmservers.org/changelog/'));
  const ai = await registry.invokeResult(message,'bot_info',{topic:'pmservers_ai'},'ai','agent');
  assert.match(ai.text,/systemone/); assert.match(ai.text,/Slopbot voice uses squall PCM WAV transcription and thunder WAV speech/);
  const prompt = await registry.invokeResult({...message,id:'t',author:'team'},'bot_info',{topic:'decision_prompt'},'prompt','agent');
  assert.match(prompt.text, /"type": "choice"/); assert.ok(!prompt.text.includes('noul'));
});
