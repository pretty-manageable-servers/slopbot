import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import type { Message } from "../src/domain.js";
import type { Embeddings } from "../src/memory.js";

const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, server: "s", channel: "c", author: "alice", text, ...extra });

test("saved memories retain author and source IDs and enter a fresh prompt", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const source = msg("1", "!remember Dinner budget is $200");
  await store.ingest(source);
  const memory = await store.remember(source, "Dinner budget is $200");
  assert.deepEqual(memory.sourceIds, ["1"]);
  const llm = new FakeLLM();
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }], recentMessages: 0 }, store);
  await app.handle(msg("2", "What is the dinner budget?"));
  const evidence = llm.prompts[0]!.inputs.find(item => item.content.includes("Evidence:\n"));
  assert.ok(evidence?.content.includes('"author":"alice"'));
  assert.ok(evidence?.content.includes('"sourceIds":["1"]'));
});

test("editing a source invalidates memory and deletion prevents stale re-ingestion", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const source = msg("1", "budget $200");
  await store.ingest(source); await store.remember(source, source.text);
  await store.revise(msg("1", "budget $300"));
  assert.equal((await store.memories("s", "c")).length, 0);
  assert.ok(!(await store.retrieve(msg("2", "budget"), 8)).some(item => item.content.includes("200")));
  await store.remove("s", "c", "1");
  assert.equal(await store.ingest(source), false);
  assert.equal((await store.retrieve(msg("2", "budget"), 8)).length, 0);
});

test("derived replies cannot resurrect deleted evidence", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const llm = new FakeLLM();
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, store);
  const result = await app.handle(msg("1", "budget $200"));
  const output = msg("out", "The budget is $200", { author: "bot" });
  await store.ingest(output); await store.linkOutput(output, result!.runId, "1");
  await store.remove("s", "c", "1");
  assert.equal(await store.ingest(output), false);
  assert.deepEqual(await store.retrieve(msg("2", "budget"), 8), []);
  assert.ok(store.events(result!.runId).some(event => event.kind === "reasoning"));
});

test("chat and saved memory retrieval never cross channel or server boundaries", async t => {
  const embeddings: Embeddings = { model: "test", async embed() { return [1, 0]; } };
  const store = new SQLiteStore(":memory:", embeddings); t.after(() => store.close());
  await store.ingest(msg("1", "secret budget", { channel: "private" }));
  await store.ingest(msg("2", "secret budget", { server: "other" }));
  await store.remember(msg("1", "secret budget", { channel: "private" }), "secret budget");
  await store.remember(msg("2", "secret budget", { server: "other" }), "secret budget");
  await store.finishIndexing();
  assert.deepEqual(await store.retrieve(msg("3", "budget"), 8), []);
});

test("only the memory author can forget their note", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const source = msg("1", "budget"); await store.ingest(source);
  const memory = await store.remember(source, "budget");
  assert.equal(await store.forget("s", "c", memory.id, "bob"), false);
  assert.equal(await store.forget("s", "c", memory.id, "alice"), true);
  assert.equal((await store.memories("s", "c")).length, 0);
  assert.ok(!(await store.retrieve(msg("2", "budget"), 8)).some(item => item.kind === 'memory'));
  assert.equal((await store.canonicalMessage('s', '1'))?.text, 'budget');
});

test("new memories append after existing task history without changing its prefix", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const llm = new FakeLLM();
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, store);
  await app.handle(msg("1", "plan", { taskId: "t" }));
  const source = msg("2", "!remember budget"); await store.ingest(source); await store.remember(source, "budget");
  await app.handle(msg("3", "continue", { taskId: "t" }));
  assert.deepEqual(llm.prompts[1]!.prefix, llm.prompts[0]!.prefix);
  assert.ok(llm.prompts[1]!.history.some(item => item.content.endsWith("[current request]: plan")));
  assert.ok(llm.prompts[1]!.inputs.some(item => item.content.includes('"kind":"memory"')));
});

test("named-person recall returns ten verbatim messages from the resolved human only", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  for (let i = 0; i < 12; i++) await store.ingest(msg(`rice-${i}`, `Rice statement ${i}`, { author: "rice", authorName: "Rice Farmer", authorAliases: ["rice_user"] }));
  await store.ingest(msg("bot", "Rice Farmer said fabricated news", { author: "bot", authorName: "Slopbot", isBot: true }));
  await store.ingest(msg("other", "other person's story", { author: "bob", authorName: "Bob" }));
  const question = msg("question", "list 10 quotes from Rice Farmer"); await store.ingest(question);
  const evidence = await store.retrieve(question, 8);
  const quotes = evidence.filter(item => item.kind === "message");
  assert.equal(quotes.length, 10);
  assert.ok(quotes.every(item => item.author === "rice" && item.content.startsWith("Rice statement") && item.sourceUrl));
});

test("unknown or ambiguous names never fall back to unrelated quotes", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.ingest(msg("one", "unrelated news", { author: "bob", authorName: "Bob" }));
  assert.ok((await store.retrieve(msg("unknown", "what has Oscar said"), 8))[0]?.content.includes("Could not resolve"));
  await store.ingest(msg("two", "another statement", { author: "bob2", authorName: "Bob" }));
  const result = await store.retrieve(msg("ambiguous", "what has Bob said"), 8);
  assert.equal(result.length, 1);
  assert.ok(result[0]?.content.includes("ambiguous"));
});

test("explicit quotes bypass generation and cannot misattribute a requester's correction", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.ingest(msg("rice-source", "I made an irrigation timer", { author: "rice", authorName: "Rice Farmer" }));
  await store.ingest(msg("correction", "I meant Rice Farmer"));
  const app = new Application(store, { async *stream() { throw new Error("quotes must use canonical text"); } }, { allowedChannels: [{ server: "s", channel: "c" }] }, store);
  const answer = (await app.handle(msg("quotes", "list 10 quotes from Rice Farmer")))!.text;
  assert.ok(answer.includes("I made an irrigation timer"));
  assert.ok(answer.includes("[source]"));
  assert.ok(!answer.includes("I meant"));
});

test("chat ingestion, edits, job queues and search never call the embedding provider", async t => {
  let calls = 0;
  const store = new SQLiteStore(":memory:", { model: "test", async embed() { calls++; return [1, 0]; } });
  t.after(() => store.close());
  const source = msg("1", "chat topic");
  await store.ingest(source);
  await store.revise({ ...source, text: "edited topic" });
  await store.enqueueJob(msg("2", "another topic"));
  assert.equal(store.reindex("s", ["c"]), 0);
  await store.finishIndexing();
  for (const mode of ["keyword", "exact", "hybrid", "semantic"] as const) {
    assert.equal((await store.searchHistory({ server: "s", channel: "c", query: "topic", mode, limit: 10 })).messages.length, 2);
  }
  assert.equal(calls, 0);
  assert.equal(store.indexStats("s", "c").vectors, 0);
});
