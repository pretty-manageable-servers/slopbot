import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { promptItems, type Message } from "../src/domain.js";
import type { LLM } from "../src/ports.js";

const scopes = [{ server: "s", channel: "c" }, { server: "s", channel: "thread" }];
const message = (id: string, text = "hello", extra: Partial<Message> = {}): Message => ({
  id, server: "s", channel: "c", author: "alice", text, ...extra,
});

function fixture(llm: LLM = new FakeLLM(), recentMessages = 12) {
  const store = new SQLiteStore();
  const app = new Application(store, llm, { allowedChannels: scopes, recentMessages });
  return { app, store };
}

test("channel requests are fresh and share an identical prefix", async t => {
  const llm = new FakeLLM();
  const { app, store } = fixture(llm);
  t.after(() => store.close());
  await app.handle(message("1"));
  await app.handle(message("2", "new request"));
  const first = llm.prompts[0]!;
  const second = llm.prompts[1]!;
  assert.deepEqual(first.prefix, second.prefix);
  assert.deepEqual(second.history, []);
  assert.ok(second.inputs.slice(0, -1).some(item => item.content.includes("hello")));
});

test("old reply references are retrieved beyond the recent window", async t => {
  const llm = new FakeLLM();
  const { app, store } = fixture(llm, 1);
  t.after(() => store.close());
  await app.handle(message("1", "important old constraint"));
  await app.handle(message("2", "unrelated"));
  await app.handle(message("3", "explain", { replyTo: "1" }));
  assert.ok(llm.prompts[2]!.inputs.some(item => item.content.includes("important old constraint")));
});

test("excluded messages never reach ingestion", async t => {
  const { app, store } = fixture();
  t.after(() => store.close());
  assert.equal(await app.handle(message("1", "secret", { channel: "private" })), undefined);
  // Inserting it directly must succeed, proving the application did not store it.
  assert.equal(await store.ingest(message("1", "secret", { channel: "private" })), true);
});

test("references cannot cross server or channel scope", async t => {
  const llm = new FakeLLM();
  const { app, store } = fixture(llm);
  t.after(() => store.close());
  await app.handle(message("1", "restricted", { channel: "thread" }));
  await store.ingest(message("foreign", "other server", { server: "other" }));
  await app.handle(message("2", "explain", { replyTo: "1" }));
  await app.handle(message("3", "explain", { replyTo: "foreign" }));
  assert.equal(llm.prompts[1]!.inputs.length, 1);
  assert.ok(!JSON.stringify(llm.prompts[2]).includes("other server"));
});

test("duplicate deliveries do not produce another run", async t => {
  const llm = new FakeLLM();
  const { app, store } = fixture(llm);
  t.after(() => store.close());
  await app.handle(message("1"));
  assert.equal(await app.handle(message("1")), undefined);
  assert.equal(llm.prompts.length, 1);
});

test("task history extends the exact previous prompt prefix", async t => {
  const llm = new FakeLLM();
  const { app, store } = fixture(llm);
  t.after(() => store.close());
  await app.handle(message("1", "first", { taskId: "t" }));
  await app.handle(message("2", "second", { taskId: "t" }));
  const first = promptItems(llm.prompts[0]!);
  assert.deepEqual(promptItems(llm.prompts[1]!).slice(0, first.length), first);
  assert.equal(llm.prompts[1]!.history.at(-1)?.role, "assistant");
});

test("task IDs do not merge histories across channels", async t => {
  const llm = new FakeLLM();
  const { app, store } = fixture(llm);
  t.after(() => store.close());
  await app.handle(message("1", "first", { taskId: "t" }));
  await app.handle(message("2", "second", { taskId: "t", channel: "thread" }));
  assert.deepEqual(llm.prompts[1]!.history, []);
});

test("reasoning and opaque payloads survive failed runs and reopening storage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopbot-test-"));
  const path = join(dir, "store.sqlite3");
  let runId = "";
  const store = new SQLiteStore(path);
  const originalStart = store.startRun.bind(store);
  store.startRun = async (id, ...args) => { runId = id; await originalStart(id, ...args); };
  const llm: LLM = {
    async *stream() {
      yield { kind: "reasoning", payload: { delta: "preserve exact payload" } };
      yield { kind: "opaque", payload: { encrypted: "opaque-data" } };
      throw new Error("connection lost");
    },
  };
  try {
    const app = new Application(store, llm, { allowedChannels: scopes });
    await assert.rejects(app.handle(message("1")), /connection lost/);
    store.close();
    const reopened = new SQLiteStore(path);
    try {
      assert.deepEqual(reopened.events(runId), [
        { kind: "reasoning", payload: { delta: "preserve exact payload" } },
        { kind: "opaque", payload: { encrypted: "opaque-data" } },
      ]);
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("untrusted messages are validated before ingestion", async t => {
  const { app, store } = fixture();
  t.after(() => store.close());
  await assert.rejects(app.handle({ ...message("1"), author: 42 }), /author/);
  await assert.rejects(app.handle({ ...message("1"), addressed: "yes" }), /addressed/);
});

test("a failed task run releases its queue for the next input", async t => {
  let calls = 0;
  const llm: LLM = {
    async *stream() {
      if (++calls === 1) throw new Error("first run failed");
      yield { kind: "text", payload: { text: "second succeeded" } };
    },
  };
  const { app, store } = fixture(llm);
  t.after(() => store.close());
  const results = await Promise.allSettled([
    app.handle(message("1", "first", { taskId: "t" })),
    app.handle(message("2", "second", { taskId: "t" })),
  ]);
  assert.equal(results[0]!.status, "rejected");
  assert.equal(results[1]!.status, "fulfilled");
});

test("tool JSON cannot be published when no executor is configured", async t => {
  const llm: LLM = { async *stream() { yield { kind: 'tool_call', payload: [{"name":"index","arguments":{"action":"status"}}] }; } };
  const { app, store } = fixture(llm); t.after(() => store.close());
  await assert.rejects(app.handle(message("request")), /tools are unavailable/);
});
