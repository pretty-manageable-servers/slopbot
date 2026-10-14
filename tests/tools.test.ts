import { errorSummary } from "../src/errors.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolError, ToolRegistry, UncertainActionError } from "../src/tools.js";
import { Application } from "../src/application.js";
import type { Message } from "../src/domain.js";
import type { LLM } from "../src/ports.js";

const message: Message = { id: "1", server: "s", channel: "t", taskId: "t", author: "alice", text: "set the limit to 5" };

test("saved tool errors retain their failure status and reason without executing again", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let executions = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register({ name: "read", description: "read", fields: {}, access: "member", effect: "read", retrySafe: true,
    async execute() { executions++; throw new ToolError("Remote service unavailable", "failed", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) }); } });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(registry.invokeResult(message, "read", {}, "error", "agent"), error =>
      error instanceof ToolError && error.status === "failed" && error.message === "Remote service unavailable" && errorSummary(error).includes("ECONNREFUSED"));
  }
  assert.equal(executions, 1);
});

test("commands and agents share permissions, validation and operation deduplication", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let admin = false, executions = 0;
  const registry = new ToolRegistry(store, async () => admin);
  registry.register({ name: "limit", description: "Set a limit", fields: { count: { type: "integer", description: "count", min: 0, max: 10, required: true } }, access: "admin", effect: "write", retrySafe: true,
    async execute(_context, args) { executions++; return `set ${args.count}`; } });
  await assert.rejects(registry.invoke(message, "limit", { count: 5 }, "op", "agent"), /Manage Server/);
  admin = true;
  await assert.rejects(registry.invoke(message, "limit", { count: 5, isAdmin: true }, "op", "agent"), /Unknown argument/);
  await assert.rejects(registry.invoke(message, "limit", { count: 11 }, "op", "command"), /Invalid integer/);
  assert.equal(await registry.invoke(message, "limit", { count: 5 }, "op", "agent"), "set 5");
  assert.equal(await registry.invoke(message, "limit", { count: 5 }, "op", "command"), "set 5");
  assert.equal(executions, 1);
  admin = false;
  await assert.rejects(registry.invoke(message, "limit", { count: 5 }, "op", "command"), /Manage Server/);
});

test("unknown external outcomes are reconciled before any repeated write", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let writes = 0, known = false;
  const registry = new ToolRegistry(store, async () => true);
  registry.register({ name: "external", description: "external action", fields: {}, access: "member", effect: "write", retrySafe: false,
    async execute() { writes++; throw new Error("lost connection after writing"); }, async reconcile() { return known ? "already done" : undefined; } });
  await assert.rejects(registry.invoke(message, "external", {}, "op", "agent"), UncertainActionError);
  await assert.rejects(registry.invoke(message, "external", {}, "op", "agent"), UncertainActionError);
  known = true;
  assert.equal(await registry.invoke(message, "external", {}, "op", "agent"), "already done");
  assert.equal(writes, 1);
});

test("resuming a failed agent run reuses completed tool results and retains the conversation", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let writes = 0, rounds = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register({ name: "limit", description: "set limit", fields: { count: { type: "integer", description: "count", required: true } }, access: "member", effect: "write", retrySafe: true,
    async execute() { writes++; return "set to 5"; } });
  const llm: LLM = { async *stream(prompt) {
    rounds++;
    yield { kind: "reasoning", payload: { delta: `round ${rounds}` } };
    if (rounds === 1) yield { kind: 'tool_call', payload: [{"name":"limit","arguments":{"count":5}}] };
    else if (rounds === 2) throw new Error("disconnected");
    else { assert.ok(prompt.inputs.some(item => item.content.includes("set to 5"))); yield { kind: "text", payload: { text: "Done." } }; }
  } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "t" }] }, undefined,
    { tools: { schemas: () => [], catalog: () => registry.catalog(), execute: (message, call, id) => registry.invoke(message, call.name, call.arguments, id, "agent") } });
  await assert.rejects(app.handle(message), /disconnected/);
  assert.equal(writes, 1);
  assert.equal((await app.handle(message, true))?.text, "Done.");
  assert.equal(writes, 1);
  const history = await store.history(JSON.stringify(["s", "t", "t"]));
  assert.ok(history.some(item => item.content.includes("set to 5")));
});

test("unknown tools and malformed tool arguments never execute", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  await assert.rejects(registry.invoke(message, "invented", {}, "op", "agent"), ToolError);
});

test("unresolved writes block other operations on the same resource until reconciled", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let writes = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register({ name: "external", description: "external action", fields: {}, access: "member", effect: "write", retrySafe: false,
    async execute() { writes++; if (writes === 1) throw new Error("connection lost"); return "done"; }, async reconcile() { return "confirmed"; } });
  await assert.rejects(registry.invoke(message, "external", {}, "first", "agent"), UncertainActionError);
  await assert.rejects(registry.invoke(message, "external", {}, "second", "command"), /did not finish/);
  assert.equal(writes, 1);
  await registry.invoke(message, "external", {}, "first", "agent");
  assert.equal(await registry.invoke(message, "external", {}, "second", "command"), "done");
});

test("source validity is checked again after asynchronous tool preparation", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let active = true, writes = 0;
  const registry = new ToolRegistry(store, async () => true, async () => { if (!active) throw new ToolError("source changed"); });
  registry.register({ name: "external", description: "external action", fields: {}, access: "member", effect: "write", retrySafe: false,
    async execute(context) { active = false; await context.assertActive(); writes++; return "done"; } });
  await assert.rejects(registry.invoke(message, "external", {}, "first", "agent"), /source changed/);
  assert.equal(writes, 0);
  assert.equal(store.operation("first")?.status, "failed");
});

test("tool JSON in model text is shown as text and never executed", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let rounds = 0, reads = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register({ name: "index", description: "index status", fields: {}, access: "member", effect: "read", retrySafe: true, async execute() { reads++; return "700 messages indexed"; } });
  const text = 'Let me check: {"tool_calls":[{"name":"index","arguments":{}}]}';
  const llm: LLM = { async *stream() {
    rounds++;
    yield { kind: "reasoning", payload: { delta: `round ${rounds}` } };
    yield { kind: "text", payload: { text } };
  } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "t" }] }, undefined,
    { tools: { schemas: () => [], catalog: () => registry.catalog(), execute: (m,c,id) => registry.invoke(m,c.name,c.arguments,id,"agent") } });
  assert.equal((await app.handle(message))?.text, text);
  assert.equal(reads, 0);
  assert.equal(rounds, 1);
});

test("known read intents return the tool result without model guessing", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registry.register({ name: "index", description: "index status", fields: {}, access: "member", effect: "read", retrySafe: true,
    matchRead: () => ({}), async execute() { return "700 messages indexed"; } });
  const llm: LLM = { async *stream() { throw new Error("model should not choose a different tool"); } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "t" }] }, undefined,
    { tools: { schemas: () => [], catalog: () => registry.catalog(), suggest: m => registry.suggest(m), execute: (m,c,id) => registry.invoke(m,c.name,c.arguments,id,"agent") } });
  assert.equal((await app.handle(message))?.text, "700 messages indexed");
});
