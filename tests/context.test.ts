import assert from "node:assert/strict";
import { test } from "node:test";
import { Application } from "../src/application.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ByteTokenCounter } from "../src/context.js";
import type { LLM } from "../src/ports.js";
import type { Message, Prompt } from "../src/domain.js";

const message = (id: string): Message => ({ id, server: "s", channel: "t", taskId: "t", author: id === "1" ? "alice" : "bob", text: `constraint ${id}: ` + "a".repeat(480) });
const key = JSON.stringify(["s", "t", "t"]);

test("long task contexts checkpoint within budget and retain original history and reasoning", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const prompts: Prompt[] = [], runIds: string[] = [];
  const start = store.startRun.bind(store);
  store.startRun = async (id, ...args) => { runIds.push(id); await start(id, ...args); };
  const llm: LLM = { async *stream(prompt) {
    prompts.push(prompt);
    yield { kind: "reasoning", payload: { delta: "keep the full reasoning" } };
    yield { kind: "text", payload: { text: prompt.purpose === "checkpoint" ? '{"goal":"shared task","constraints":[{"author_id":"alice","text":"constraint 1","source_ids":["1"]}],"disagreements":[],"progress":["ongoing"],"decisions":[],"artifacts":[],"pending_actions":[]}' : "answer " + "b".repeat(120) } };
  } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "t" }], maxInputChars: 2120, maxOutputTokens: 700, checkpointTokens: 700 });
  for (let i = 1; i <= 6; i++) await app.handle(message(String(i)));
  assert.ok(prompts.some(prompt => prompt.purpose === "checkpoint"));
  assert.ok((await store.taskContext(key)).checkpoint);
  assert.equal(store.historyArchive(key).length, 12);
  for (const prompt of prompts) assert.ok(new ByteTokenCounter().count([...prompt.prefix, ...prompt.history, ...prompt.inputs]) <= 2120);
  for (const run of runIds) assert.ok(store.events(run).some(event => event.kind === "reasoning"));
  await store.revise({ ...message("1"), text: "corrected constraint" });
  assert.equal((await store.taskContext(key)).checkpoint, null);
  assert.equal((await store.history(key)).length, 0);
  assert.equal(store.historyArchive(key).length, 12);
});

test("multibyte input cannot slip through a character-only budget", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const llm: LLM = { async *stream() { throw new Error("must not call provider"); } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "t" }], maxInputChars: 1000 });
  await assert.rejects(app.handle({ ...message("1"), text: "🙂".repeat(250) }), /Request exceeds context budget/);
});
