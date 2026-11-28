import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PostgresStore } from "../src/adapters/postgres.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { pgAssistantStore } from "../src/assistant/pg-store.js";
import { sqliteAssistantStore } from "../src/assistant/sqlite-store.js";
import type { AssistantStore } from "../src/assistant/store.js";
import type { ActivityItem, ApprovalRequest, AssistantSettings, AssistantTask, Trigger } from "../src/assistant/types.js";

type Scenario = (store: AssistantStore) => Promise<void>;

// Each scenario runs on SQLite always and on Postgres when TEST_DATABASE_URL is set.
function scenario(name: string, run: Scenario) {
  test(name, async () => {
    const sqlite = new SQLiteStore(":memory:");
    try { await run(sqliteAssistantStore(sqlite)); }
    finally { sqlite.close(); }
  });
  test(`${name} on Postgres`, { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const url = process.env.TEST_DATABASE_URL!;
    const schema = `slopbot_assistant_${randomBytes(6).toString("hex")}`;
    const postgres = await PostgresStore.connect(url, undefined, schema);
    try { await run(pgAssistantStore(postgres)); }
    finally {
      await postgres.close();
      const cleanup = new Client({ connectionString: url });
      await cleanup.connect();
      try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await cleanup.end(); }
    }
  });
}

const task = (id: string, patch: Partial<AssistantTask> = {}): AssistantTask => ({
  id, owner: "u1", goal: `goal ${id}`, instructions: "check things", status: "active", pause: null, wake: { kind: "interval", minutes: 60 },
  nextAt: 1000, rules: { shell: "ask" }, effort: "low", failures: 0, lastRunAt: null, lastError: null, createdAt: 1, updatedAt: 1, revision: 1, ...patch,
});
const approval = (id: string, patch: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id, owner: "u1", task: null, run: "run-1", tool: "shell", input: { cmd: "ls" }, summary: `run ls ${id}`, status: "pending", result: null,
  createdAt: 1, decidedAt: null, expiresAt: 100_000, ...patch,
});
const activity = (id: string, patch: Partial<ActivityItem> = {}): ActivityItem => ({
  id, owner: "u1", task: null, kind: "update", text: `text ${id}`, ref: null, createdAt: 1, readAt: null, ...patch,
});
const settings = (user: string, patch: Partial<AssistantSettings> = {}): AssistantSettings => ({
  user, enabled: true, briefCron: "0 8 * * *", timezone: "UTC", dmUpdates: false, quietStart: null, quietEnd: null, updated: 1, ...patch,
});
const ids = <T extends { id: string }>(rows: T[]) => rows.map(row => row.id);

scenario("put task insert and CAS miss", async store => {
  assert.equal(await store.putTask(task("t1"), null), true);
  assert.equal(await store.putTask(task("t1", { goal: "again" }), null), false);
  assert.deepEqual(await store.task("t1"), task("t1"));

  assert.equal(await store.putTask({ ...task("t1"), goal: "edited" }, 1), true);
  assert.equal(await store.putTask({ ...task("t1"), goal: "stale" }, 1), false);
  const current = await store.task("t1");
  assert.equal(current?.goal, "edited");
  assert.equal(current?.revision, 2);

  assert.equal(await store.putTask({ ...task("t1"), goal: "next" }, 2), true);
  assert.equal((await store.task("t1"))?.revision, 3);
  assert.equal(await store.task("missing"), undefined);
});

scenario("due tasks order and limit", async store => {
  await store.putTask(task("late", { nextAt: 300 }), null);
  await store.putTask(task("early", { nextAt: 100 }), null);
  await store.putTask(task("middle", { nextAt: 200 }), null);
  await store.putTask(task("future", { nextAt: 500 }), null);
  await store.putTask(task("paused", { nextAt: 50, status: "paused", pause: "owner" }), null);
  await store.putTask(task("unscheduled", { nextAt: null }), null);

  assert.deepEqual(ids(await store.dueTasks(400, 10)), ["early", "middle", "late"]);
  assert.deepEqual(ids(await store.dueTasks(400, 2)), ["early", "middle"]);
});

scenario("decide approval only once", async store => {
  await store.addApproval(approval("ap1", { createdAt: 1 }));
  await store.addApproval(approval("ap2", { createdAt: 2 }));
  await store.addApproval(approval("ap3", { createdAt: 3, owner: "u2" }));

  assert.equal(await store.decideApproval("ap1", "approved", "ok", 5), true);
  assert.equal(await store.decideApproval("ap1", "denied", "late", 6), false);
  assert.deepEqual(await store.approval("ap1"), { ...approval("ap1", { createdAt: 1 }), status: "approved", result: "ok", decidedAt: 5 });
  assert.deepEqual(ids(await store.pendingApprovals("u1")), ["ap2"]);
  assert.deepEqual(ids(await store.pendingApprovals("u2")), ["ap3"]);
});

scenario("set the result of an approved approval", async store => {
  await store.addApproval(approval("ap1", { createdAt: 1 }));
  await store.addApproval(approval("ap2", { createdAt: 2 }));
  await store.setApprovalResult("ap1", "failed", "no");
  assert.equal((await store.approval("ap1"))?.status, "pending");
  await store.decideApproval("ap1", "approved", null, 5);
  await store.setApprovalResult("ap1", "failed", "boom");
  assert.deepEqual(await store.approval("ap1"), { ...approval("ap1", { createdAt: 1 }), status: "failed", result: "boom", decidedAt: 5 });
});

scenario("triggers taken once", async store => {
  const trigger = (id: string, patch: Partial<Trigger>): Trigger => ({ id, owner: "u1", task: null, kind: "user", payload: { text: id }, createdAt: 1, takenAt: null, ...patch });
  await store.addTrigger(trigger("t2", { createdAt: 2 }));
  await store.addTrigger(trigger("t1", { createdAt: 1, kind: "timer", payload: {} }));
  await store.addTrigger(trigger("other", { owner: "u2" }));

  assert.deepEqual(await store.takeTriggers("u1", 10), [
    trigger("t1", { createdAt: 1, kind: "timer", payload: {}, takenAt: 10 }),
    trigger("t2", { createdAt: 2, takenAt: 10 }),
  ]);
  assert.deepEqual(await store.takeTriggers("u1", 11), []);
  assert.deepEqual(ids(await store.takeTriggers("u2", 12)), ["other"]);
});

scenario("activity paging", async store => {
  for (const [index, id] of ["a1", "a2", "a3", "a4", "a5"].entries()) await store.addActivity(activity(id, { createdAt: (index + 1) * 100 }));
  await store.addActivity(activity("foreign", { owner: "u2", createdAt: 999 }));

  assert.deepEqual(ids(await store.activity("u1", null, 2)), ["a5", "a4"]);
  assert.deepEqual(ids(await store.activity("u1", 400, 2)), ["a3", "a2"]);
  assert.deepEqual(ids(await store.activity("u1", 100, 10)), []);
  assert.deepEqual(await store.activity("u1", null, 1), [activity("a5", { createdAt: 500 })]);
});

scenario("mark read only own items", async store => {
  await store.addActivity(activity("x1"));
  await store.addActivity(activity("x2"));
  await store.addActivity(activity("y1", { owner: "u2" }));

  await store.markRead("u1", ["x1", "y1"], 50);
  assert.deepEqual(await store.activity("u1", null, 10), [activity("x2"), activity("x1", { readAt: 50 })]);
  assert.deepEqual(await store.activity("u2", null, 10), [activity("y1", { owner: "u2" })]);
});

scenario("due briefs", async store => {
  await store.putSettings(settings("due-early"));
  await store.putSettings(settings("due-late"));
  await store.putSettings(settings("no-cron", { briefCron: null }));
  await store.putSettings(settings("disabled", { enabled: false }));
  await store.putSettings(settings("future"));
  await store.setBriefNextAt("due-early", 100);
  await store.setBriefNextAt("due-late", 150);
  await store.setBriefNextAt("no-cron", 50);
  await store.setBriefNextAt("disabled", 60);
  await store.setBriefNextAt("future", 300);

  assert.deepEqual((await store.dueBriefs(200, 10)).map(s => s.user), ["due-early", "due-late"]);
  assert.deepEqual((await store.dueBriefs(200, 1)).map(s => s.user), ["due-early"]);

  // putSettings must not reset the schedule.
  await store.putSettings(settings("due-early", { timezone: "Europe/Berlin", updated: 2 }));
  assert.deepEqual((await store.dueBriefs(200, 10)).map(s => s.user), ["due-early", "due-late"]);
  await store.setBriefNextAt("due-early", null);
  assert.deepEqual((await store.dueBriefs(200, 10)).map(s => s.user), ["due-late"]);
});
