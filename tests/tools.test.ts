import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolError, ToolRegistry, UncertainActionError } from "../src/tools.js";
import { Application } from "../src/application.js";
import type { Message } from "../src/domain.js";
import type { LLM } from "../src/ports.js";

const message: Message = { id: "1", server: "s", channel: "t", taskId: "t", author: "alice", text: "set the limit to 5" };

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
    if (rounds === 1) yield { kind: "text", payload: { text: '{"tool_calls":[{"name":"limit","arguments":{"count":5}}]}' } };
    else if (rounds === 2) throw new Error("disconnected");
    else { assert.ok(prompt.inputs.some(item => item.content.includes("set to 5"))); yield { kind: "text", payload: { text: "Done." } }; }
  } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "t" }] }, undefined,
    { tools: { catalog: () => registry.catalog(), execute: (message, call, id) => registry.invoke(message, call.name, call.arguments, id, "agent") } });
  await assert.rejects(app.handle(message), /disconnected/);
  assert.equal(writes, 1);
  assert.equal((await app.handle(message, true))?.text, "Done.");
  assert.equal(writes, 1);
  const history = await store.history(JSON.stringify(["s", "t", "t"]));
  assert.ok(history.some(item => item.content.includes('"tool_calls"')));
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
  await assert.rejects(registry.invoke(message, "external", {}, "second", "command"), /unresolved action/);
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

test("malformed tool output gets repaired without leaking JSON or executing twice", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let rounds = 0, reads = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register({ name: "index", description: "index status", fields: {}, access: "member", effect: "read", retrySafe: true, async execute() { reads++; return "700 messages indexed"; } });
  const llm: LLM = { async *stream() {
    rounds++;
    yield { kind: "reasoning", payload: { delta: `round ${rounds}` } };
    yield { kind: "text", payload: { text: rounds === 1 ? 'Let me check: {"tool_calls":[{"name":"index","arguments":{}}]}' : rounds === 2 ? '{"tool_calls":[{"name":"index","arguments":{}}]}' : "700 messages indexed." } };
  } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "t" }] }, undefined,
    { tools: { catalog: () => registry.catalog(), execute: (m,c,id) => registry.invoke(m,c.name,c.arguments,id,"agent") } });
  assert.equal((await app.handle(message))?.text, "700 messages indexed.");
  assert.equal(reads, 1);
  assert.equal(rounds, 3);
});

test("known read intents return the tool result without model guessing", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registry.register({ name: "index", description: "index status", fields: {}, access: "member", effect: "read", retrySafe: true,
    matchRead: () => ({}), async execute() { return "700 messages indexed"; } });
  const llm: LLM = { async *stream() { throw new Error("model should not choose a different tool"); } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "t" }] }, undefined,
    { tools: { catalog: () => registry.catalog(), suggest: m => registry.suggest(m), execute: (m,c,id) => registry.invoke(m,c.name,c.arguments,id,"agent") } });
  assert.equal((await app.handle(message))?.text, "700 messages indexed");
});
