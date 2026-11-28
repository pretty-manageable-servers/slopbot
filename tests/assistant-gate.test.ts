import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { PERSONAL_SERVER } from "../src/personal.js";
import { ToolRegistry, type ToolDefinition } from "../src/tools.js";
import { Gate } from "../src/assistant/gate.js";
import { DEFAULT_ASSISTANT_LIMITS, type ActivityItem, type ApprovalRequest, type AssistantTask, type Notifier, type RuleEffect, type Trigger } from "../src/assistant/types.js";
import type { AssistantStore } from "../src/assistant/store.js";
import type { Message } from "../src/domain.js";

const owner = "alice";
const HOUR_MS = 3600e3;

/** In-memory AssistantStore. Only the methods the gate uses do anything. */
class FakeStore implements AssistantStore {
  taskRows = new Map<string, AssistantTask>();
  approvals = new Map<string, ApprovalRequest>();
  triggers: Trigger[] = [];
  activities: ActivityItem[] = [];
  async settings() { return undefined; }
  async putSettings() { throw new Error("unused"); }
  async tasks(): Promise<AssistantTask[]> { return [...this.taskRows.values()]; }
  async task(id: string) { return this.taskRows.get(id); }
  async putTask(t: AssistantTask, expectedRevision: number | null): Promise<boolean> {
    const current = this.taskRows.get(t.id);
    if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) return false;
    this.taskRows.set(t.id, t);
    return true;
  }
  async dueTasks() { return []; }
  async dueBriefs() { return []; }
  async setBriefNextAt() { throw new Error("unused"); }
  async addTrigger(t: Trigger) { this.triggers.push(t); }
  async takeTriggers() { return []; }
  async addApproval(a: ApprovalRequest) { this.approvals.set(a.id, a); }
  async approval(id: string) { return this.approvals.get(id); }
  async decideApproval(id: string, status: ApprovalRequest["status"], result: string | null, now: number): Promise<boolean> {
    const a = this.approvals.get(id);
    if (!a || a.status !== "pending") return false;
    this.approvals.set(id, { ...a, status, result, decidedAt: now });
    return true;
  }
  async pendingApprovals(who: string) { return [...this.approvals.values()].filter(a => a.owner === who && a.status === "pending"); }
  async addActivity(a: ActivityItem) { this.activities.push(a); }
  async activity() { return []; }
  async markRead() { throw new Error("unused"); }
}

const task = (id: string, rules: Record<string, RuleEffect> = {}): AssistantTask => ({
  id, owner, goal: "goal", instructions: "", status: "active", pause: null, wake: { kind: "interval", minutes: 60 }, nextAt: null,
  rules, effort: "low", failures: 0, lastRunAt: null, lastError: null, createdAt: 1, updatedAt: 1, revision: 1,
});

function setup() {
  const store = new FakeStore();
  const notified: { item: ActivityItem; approval: ApprovalRequest | undefined }[] = [];
  const notifier: Notifier = { async notify(item, approval) { notified.push({ item, approval }); } };
  const journal = new SQLiteStore(":memory:");
  const registry = new ToolRegistry(journal, async () => false);
  const calls: Record<string, number> = { note_read: 0, note_write: 0, task_note: 0 };
  const tool = (name: string, effect: "read" | "write", retrySafe: boolean): ToolDefinition => ({
    name, description: name, fields: { text: { type: "string", description: "Note text." } }, access: "member", effect, retrySafe,
    execute: async () => { calls[name] = (calls[name] ?? 0) + 1; return `${name} ran`; },
  });
  registry.register(tool("note_read", "read", true));
  registry.register(tool("note_write", "write", false));
  registry.register(tool("task_note", "write", false));
  let clock = 1_000;
  let ids = 0;
  const gate = new Gate({ store, notifier, limits: async () => DEFAULT_ASSISTANT_LIMITS, registry: () => registry, now: () => clock, id: () => `id${++ids}` });
  registry.setAssistantGate(gate);
  const advance = (ms: number) => { clock += ms; };
  return { store, notified, registry, gate, calls, advance, close: () => journal.close() };
}

const assistantMessage = (id: string, taskId: string | null): Message => ({
  id, server: PERSONAL_SERVER, channel: taskId ? `web:assistant-task:${taskId}` : `web:assistant:${owner}`, author: owner, text: "", surface: "web",
  assistant: { owner, task: taskId, trigger: "timer" },
});

const plainMessage = (id: string): Message => ({ id, server: PERSONAL_SERVER, channel: `web:assistant:${owner}`, author: owner, text: "", surface: "web" });

const onlyApproval = (store: FakeStore): ApprovalRequest => {
  const [approval] = store.approvals.values();
  assert.ok(approval, "an approval was queued");
  return approval;
};

test("read tool runs without approval", async (t) => {
  const s = setup(); t.after(s.close);
  s.store.taskRows.set("t1", task("t1"));
  const result = await s.registry.invokeResult(assistantMessage("m1", "t1"), "note_read", {}, "op-read", "agent");
  assert.equal(result.text, "note_read ran");
  assert.equal(s.calls.note_read, 1);
  assert.equal(s.store.approvals.size, 0);
});

test("write tool queued by default", async (t) => {
  const s = setup(); t.after(s.close);
  s.store.taskRows.set("t1", task("t1"));
  const result = await s.registry.invokeResult(assistantMessage("m1", "t1"), "note_write", { text: "hi" }, "op-write", "agent");
  assert.match(result.text, /^Queued for approval id\d+\. Continue without it\.$/);
  assert.equal(s.calls.note_write, 0);
  const approval = onlyApproval(s.store);
  assert.equal(approval.status, "pending");
  assert.equal(approval.task, "t1");
  assert.equal(approval.run, "m1");
  assert.deepEqual(approval.input, { text: "hi" });
  assert.equal(approval.summary, 'note_write: {"text":"hi"}');
  assert.equal(s.notified.length, 1);
  assert.equal(s.notified[0]?.approval?.id, approval.id);
});

test("allow rule runs write", async (t) => {
  const s = setup(); t.after(s.close);
  s.store.taskRows.set("t1", task("t1", { note_write: "allow" }));
  const result = await s.registry.invokeResult(assistantMessage("m1", "t1"), "note_write", {}, "op-write", "agent");
  assert.equal(result.text, "note_write ran");
  assert.equal(s.calls.note_write, 1);
  assert.equal(s.store.approvals.size, 0);
});

test("block rule refuses", async (t) => {
  const s = setup(); t.after(s.close);
  s.store.taskRows.set("t1", task("t1", { note_read: "block" }));
  await assert.rejects(s.registry.invokeResult(assistantMessage("m1", "t1"), "note_read", {}, "op-read", "agent"), { message: "Blocked by your rules for this sprout." });
  assert.equal(s.calls.note_read, 0);
});

test("approve runs stored call once", async (t) => {
  const s = setup(); t.after(s.close);
  s.store.taskRows.set("t1", task("t1"));
  await s.registry.invokeResult(assistantMessage("m1", "t1"), "note_write", { text: "hi" }, "op-write", "agent");
  const approval = onlyApproval(s.store);
  const result = await s.gate.execute(approval.id, owner);
  assert.equal(result.text, "note_write ran");
  assert.equal(s.calls.note_write, 1);
  assert.equal(s.store.approvals.get(approval.id)?.status, "approved");
  assert.deepEqual(s.store.triggers.at(-1)?.payload, { approval: approval.id, tool: "note_write", result: "note_write ran" });
  assert.equal(s.store.triggers.at(-1)?.task, "t1");
  await assert.rejects(s.gate.execute(approval.id, owner), { message: "Already decided." });
  assert.equal(s.calls.note_write, 1);
});

test("deny stores no call", async (t) => {
  const s = setup(); t.after(s.close);
  s.store.taskRows.set("t1", task("t1"));
  await s.registry.invokeResult(assistantMessage("m1", "t1"), "note_write", {}, "op-write", "agent");
  const approval = onlyApproval(s.store);
  await s.gate.deny(approval.id, owner);
  assert.equal(s.store.approvals.get(approval.id)?.status, "denied");
  assert.deepEqual(s.store.triggers.at(-1)?.payload, { approval: approval.id, denied: true });
  await assert.rejects(s.gate.execute(approval.id, owner), { message: "Already decided." });
  assert.equal(s.calls.note_write, 0);
});

test("expired cannot be approved", async (t) => {
  const s = setup(); t.after(s.close);
  s.store.taskRows.set("t1", task("t1"));
  await s.registry.invokeResult(assistantMessage("m1", "t1"), "note_write", {}, "op-write", "agent");
  const approval = onlyApproval(s.store);
  s.advance(DEFAULT_ASSISTANT_LIMITS.approvalTtlHours * HOUR_MS);
  await assert.rejects(s.gate.execute(approval.id, owner), { message: "This approval expired." });
  assert.equal(s.store.approvals.get(approval.id)?.status, "expired");
  assert.equal(s.calls.note_write, 0);
});

test("always sets rule", async (t) => {
  const s = setup(); t.after(s.close);
  s.store.taskRows.set("t1", task("t1"));
  await s.registry.invokeResult(assistantMessage("m1", "t1"), "note_write", {}, "op-write", "agent");
  const approval = onlyApproval(s.store);
  await s.gate.execute(approval.id, owner, true);
  assert.equal(s.store.taskRows.get("t1")?.rules.note_write, "allow");
  assert.equal(s.calls.note_write, 1);
  await s.registry.invokeResult(assistantMessage("m2", "t1"), "note_write", {}, "op-write-2", "agent");
  assert.equal(s.calls.note_write, 2);
  assert.equal(s.store.approvals.size, 1);
});

test("other user cannot approve", async (t) => {
  const s = setup(); t.after(s.close);
  s.store.taskRows.set("t1", task("t1"));
  await s.registry.invokeResult(assistantMessage("m1", "t1"), "note_write", {}, "op-write", "agent");
  const approval = onlyApproval(s.store);
  await assert.rejects(s.gate.execute(approval.id, "mallory"), { message: "Not found." });
  assert.equal(s.store.approvals.get(approval.id)?.status, "pending");
  assert.equal(s.calls.note_write, 0);
});

test("non-assistant message unaffected", async (t) => {
  const s = setup(); t.after(s.close);
  const result = await s.registry.invokeResult(plainMessage("m1"), "note_write", {}, "op-write", "agent");
  assert.equal(result.text, "note_write ran");
  assert.equal(s.calls.note_write, 1);
  assert.equal(s.store.approvals.size, 0);
});

test("internal tools bypass gate", async (t) => {
  const s = setup(); t.after(s.close);
  s.store.taskRows.set("t1", task("t1"));
  const result = await s.registry.invokeResult(assistantMessage("m1", "t1"), "task_note", {}, "op-note", "agent");
  assert.equal(result.text, "task_note ran");
  assert.equal(s.calls.task_note, 1);
  assert.equal(s.store.approvals.size, 0);
});
