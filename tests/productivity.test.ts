import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry } from "../src/tools.js";
import { registerTaskTools } from "../src/productivity/tasks.js";
import {
  registerReminderTools,
  ReminderWorker,
  type Reminder,
} from "../src/productivity/reminders.js";
import type { Json } from "../src/domain.js";
const message = {
  server: "s",
  channel: "c",
  author: "u",
  id: "request",
  text: "Task",
};
test("tracked tasks enforce ownership and concurrent revisions", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registerTaskTools(registry, { store, authorize: async () => {} });
  const result = await registry.invokeResult(
    message,
    "task_manage",
    { action: "create", goal: "Ship bot" },
    "create",
    "agent",
  );
  const id = result.text.match(/Reference: (\w+)/)![1]!;
  await assert.rejects(
    registry.invokeResult(
      { ...message, author: "other" },
      "task_manage",
      { action: "complete", id },
      "other",
      "agent",
    ),
    /creator, owner/,
  );
  const done = await registry.invokeResult(
    message,
    "task_manage",
    { action: "complete", id },
    "done",
    "agent",
  );
  assert.match(done.text, /done/);
  assert.equal((await store.records("s", "task")).length, 1);
});
test("reminders reject ambiguous timestamps and persist across worker restart", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  let now = Date.parse("2026-10-10T00:00:00Z");
  registerReminderTools(
    registry,
    { store, authorize: async () => {} },
    () => now,
  );
  await assert.rejects(
    registry.invokeResult(
      message,
      "reminder",
      { action: "create", at: "2026-10-11T12:00:00", text: "Ship" },
      "ambiguous",
      "agent",
    ),
    /timezone/,
  );
  const result = await registry.invokeResult(
    message,
    "reminder",
    { action: "create", at: "2026-10-10T00:01:00Z", text: "Ship" },
    "schedule",
    "agent",
  );
  const id = result.text.match(/Reference: (\w+)/)![1]!;
  const deliveries: string[] = [];
  now += 120000;
  const deliver = async (_m: unknown, _text: string, id: string) => {
    deliveries.push(id);
  };
  const worker = new ReminderWorker(
    "s",
    store,
    deliver,
    async () => {},
    () => now,
  );
  const other = new ReminderWorker(
    "s",
    store,
    deliver,
    async () => {},
    () => now,
  );
  await Promise.all([worker.tick(), other.tick()]);
  await other.tick();
  assert.deepEqual(deliveries, [`reminder:${id}`]);
  assert.equal(
    ((await store.record("s", "reminder", id))?.value as unknown as Reminder)
      .status,
    "sent",
  );
});
test("reminder access revocation blocks delivery and cancellation prevents sending", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const reminder: Reminder = {
    channel: "c",
    owner: "u",
    text: "Hi",
    at: 1,
    status: "scheduled",
  };
  await store.putRecord("s", "reminder", "r", reminder as unknown as Json, 0);
  let sent = 0;
  const worker = new ReminderWorker(
    "s",
    store,
    async () => {
      sent++;
    },
    async () => {
      throw Error("no access");
    },
    () => 10,
  );
  await worker.tick();
  assert.equal(sent, 0);
  const record = (await store.record("s", "reminder", "r"))!;
  assert.match((record.value as unknown as Reminder).error ?? "", /no access/);
  const registry = new ToolRegistry(store, async () => false);
  registerReminderTools(registry, { store, authorize: async () => {} });
  await registry.invokeResult(
    message,
    "reminder",
    { action: "cancel", id: "r" },
    "cancel",
    "agent",
  );
  await new ReminderWorker(
    "s",
    store,
    async () => {
      sent++;
    },
    async () => {},
    () => 100000,
  ).tick();
  assert.equal(sent, 0);
});
