import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { AssistantStore } from "../src/assistant/store.js";
import { registerAssistantTools, type AssistantToolDeps } from "../src/assistant/tools.js";
import {
  assistantHomeChannel,
  assistantTaskChannel,
  DEFAULT_ASSISTANT_LIMITS,
  type ActivityItem,
  type AssistantTask,
} from "../src/assistant/types.js";
import type { Message } from "../src/domain.js";
import { ToolError, ToolRegistry } from "../src/tools.js";

class MemoryAssistantStore implements AssistantStore {
  readonly taskRows = new Map<string, AssistantTask>();
  readonly activities: ActivityItem[] = [];
  async settings() { return undefined; }
  async putSettings() {}
  async tasks(owner: string) { return [...this.taskRows.values()].filter(task => task.owner === owner); }
  async task(id: string) { return this.taskRows.get(id); }
  async putTask(task: AssistantTask, expectedRevision: number | null) {
    const current = this.taskRows.get(task.id);
    if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) return false;
    this.taskRows.set(task.id, task);
    return true;
  }
  async dueTasks(now: number, limit: number) {
    return [...this.taskRows.values()].filter(task => task.status === "active" && task.nextAt !== null && task.nextAt <= now).slice(0, limit);
  }
  async dueBriefs() { return []; }
  async setBriefNextAt() {}
  async addTrigger() {}
  async takeTriggers() { return []; }
  async addApproval() {}
  async approval() { return undefined; }
  async decideApproval() { return false; }
  async pendingApprovals() { return []; }
  async addActivity(item: ActivityItem) { this.activities.push(item); }
  async activity(owner: string, _before: number | null, limit: number) { return this.activities.filter(item => item.owner === owner).slice(0, limit); }
  async markRead() {}
}

const homeMessage = (owner = "u1"): Message => ({
  server: "s", channel: assistantHomeChannel(owner), author: owner, id: "m1", text: "go",
  assistant: { owner, task: null, trigger: "user" },
});
const taskMessage = (task: string, owner = "u1"): Message => ({
  ...homeMessage(owner), channel: assistantTaskChannel(task), assistant: { owner, task, trigger: "timer" },
});

async function setup(t: { after(fn: () => void | Promise<void>): void }, overrides: Partial<AssistantToolDeps> = {}) {
  const store = new MemoryAssistantStore();
  const journal = new SQLiteStore();
  t.after(() => journal.close());
  const notified: ActivityItem[] = [];
  const chats: { channel: string; owner: string; title: string }[] = [];
  const registry = new ToolRegistry(journal, async () => true);
  let ids = 0, operations = 0;
  registerAssistantTools(registry, {
    store,
    notifier: { async notify(item) { notified.push(item); } },
    limits: async () => DEFAULT_ASSISTANT_LIMITS,
    memory: { async remember() {} },
    chats: { async ensure(channel, owner, title) { chats.push({ channel, owner, title }); } },
    now: () => 1_000,
    id: () => `id${++ids}`,
    ...overrides,
  });
  const call = (message: Message, name: string, input: Record<string, unknown>) =>
    registry.invokeResult(message, name, input, `op${++operations}`, "agent");
  return { store, notified, chats, call };
}

const sprout = { goal: "Watch the build", wake: { kind: "interval", minutes: 120 } };

test("propose over cap refused", async (t) => {
  const { store, call } = await setup(t, { limits: async () => ({ ...DEFAULT_ASSISTANT_LIMITS, maxActiveTasks: 2 }) });
  await call(homeMessage(), "task_propose", sprout);
  await call(homeMessage(), "task_propose", sprout);
  await assert.rejects(call(homeMessage(), "task_propose", sprout), (error: unknown) => error instanceof ToolError && error.message === "Limit reached: 2 active sprouts.");
  assert.equal((await store.tasks("u1")).length, 2);
});

test("propose below min interval refused", async (t) => {
  const { store, call } = await setup(t);
  await assert.rejects(
    call(homeMessage(), "task_propose", { ...sprout, wake: { kind: "interval", minutes: 30 } }),
    (error: unknown) => error instanceof ToolError && error.message === "Sprouts wake at most every 60 minutes.",
  );
  assert.equal((await store.tasks("u1")).length, 0);
});

test("propose only from home", async (t) => {
  const { store, call } = await setup(t);
  await assert.rejects(call(taskMessage("t1"), "task_propose", sprout), (error: unknown) => error instanceof ToolError && error.message === "Propose sprouts from the Bud home thread.");
  assert.equal((await store.tasks("u1")).length, 0);
});

test("propose stores a proposed sprout and opens its chat", async (t) => {
  const { store, chats, call } = await setup(t);
  await call(homeMessage(), "task_propose", { ...sprout, effort: "low", rules: { shell: "ask" } });
  const [task] = await store.tasks("u1");
  assert.equal(task?.status, "proposed");
  assert.equal(task?.nextAt, null);
  assert.equal(task?.effort, "low");
  assert.deepEqual(task?.rules, { shell: "ask" });
  assert.deepEqual(chats, [{ channel: assistantTaskChannel(task!.id), owner: "u1", title: "Watch the build" }]);
  assert.deepEqual(store.activities.map(item => [item.kind, item.ref]), [["proposal", task!.id]]);
});

test("notify dm calls notifier", async (t) => {
  const { store, notified, call } = await setup(t);
  await call(taskMessage("t1"), "assistant_notify", { text: "Build is green", level: "dm" });
  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.text, "Build is green");
  assert.equal(store.activities.length, 1);
  assert.equal(store.activities[0]?.task, "t1");
});

test("notify feed no dm", async (t) => {
  const { store, notified, call } = await setup(t);
  await call(homeMessage(), "assistant_notify", { text: "Nothing new", level: "feed" });
  assert.deepEqual(notified, []);
  assert.deepEqual(store.activities.map(item => [item.kind, item.text, item.task]), [["update", "Nothing new", null]]);
});

test("finish stops wakes", async (t) => {
  const { store, call } = await setup(t);
  const task: AssistantTask = {
    id: "t1", owner: "u1", goal: "Watch", instructions: "", status: "active", pause: null, wake: { kind: "interval", minutes: 120 },
    nextAt: 1_000, rules: {}, effort: "medium", failures: 0, lastRunAt: null, lastError: null, createdAt: 1, updatedAt: 1, revision: 1,
  };
  await store.putTask(task, null);
  await call(taskMessage("t1"), "task_finish", { summary: "Built it" });
  const finished = await store.task("t1");
  assert.equal(finished?.status, "done");
  assert.equal(finished?.nextAt, null);
  assert.deepEqual(await store.dueTasks(1_000_000, 10), []);
  assert.deepEqual(store.activities.map(item => [item.kind, item.text]), [["done", "Built it"]]);
});

test("tools refuse without assistant tag", async (t) => {
  const { store, call } = await setup(t);
  const { assistant: _tag, ...untagged } = homeMessage();
  await assert.rejects(call(untagged, "assistant_idle", {}), ToolError);
  await assert.rejects(call(untagged, "assistant_notify", { text: "hi", level: "feed" }), ToolError);
  await assert.rejects(call(untagged, "task_propose", sprout), ToolError);
  assert.equal(store.activities.length, 0);
  assert.equal((await store.tasks("u1")).length, 0);
});
