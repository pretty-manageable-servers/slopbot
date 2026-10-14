import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry } from "../src/tools.js";
import {
  registerReminderTools,
  ReminderWorker,
  type Reminder,
} from "../src/productivity/reminders.js";
import type { Json, Message } from "../src/domain.js";

const message: Message = {
  server: "s",
  channel: "c",
  author: "u",
  id: "request",
  text: "Cancel",
};

// Like DiscordAPIError: the error has a numeric `code`.
function discordError(code: number, text: string): Error {
  return Object.assign(new Error(text), { code });
}

test("reminder with unknown channel is marked failed and not retried", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const reminder: Reminder = {
    channel: "gone",
    owner: "u",
    text: "Hi",
    at: 1,
    status: "scheduled",
  };
  await store.putRecord("s", "reminder", "r", reminder as unknown as Json, 0);
  let sent = 0;
  let checks = 0;
  const worker = new ReminderWorker(
    "s",
    store,
    async () => {
      sent++;
    },
    async () => {
      checks++;
      throw discordError(10003, "Unknown Channel");
    },
    () => 10,
  );
  await worker.tick();
  await worker.tick();
  assert.equal(checks, 1);
  assert.equal(sent, 0);
  const saved = (await store.record("s", "reminder", "r"))!
    .value as unknown as Reminder;
  assert.equal(saved.status, "failed");
  assert.equal(saved.retryAt, 0);
  assert.match(saved.error ?? "", /Unknown Channel/);
});

test("reminder with unknown channel fails on delivery and is not retried", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const reminder: Reminder = {
    channel: "gone",
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
      throw discordError(50013, "Missing Permissions");
    },
    async () => {},
    () => 10,
  );
  await worker.tick();
  await worker.tick();
  assert.equal(sent, 1);
  const saved = (await store.record("s", "reminder", "r"))!
    .value as unknown as Reminder;
  assert.equal(saved.status, "failed");
  assert.match(saved.error ?? "", /Missing Permissions/);
});

test("reminder with a temporary error is retried", async (t) => {
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
  let now = 10;
  let checks = 0;
  const deliveries: string[] = [];
  const worker = new ReminderWorker(
    "s",
    store,
    async (_message, _text, id) => {
      deliveries.push(id);
    },
    async () => {
      checks++;
      if (checks === 1) throw discordError(503, "Service Unavailable");
    },
    () => now,
  );
  await worker.tick();
  const waiting = (await store.record("s", "reminder", "r"))!
    .value as unknown as Reminder;
  assert.equal(waiting.status, "scheduled");
  assert.match(waiting.error ?? "", /Service Unavailable/);
  now += 60001;
  await worker.tick();
  assert.equal(checks, 2);
  assert.deepEqual(deliveries, ["reminder:r"]);
  const saved = (await store.record("s", "reminder", "r"))!
    .value as unknown as Reminder;
  assert.equal(saved.status, "sent");
});

test("cancel on failed reminder is refused", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const reminder: Reminder = {
    channel: "c",
    owner: "u",
    text: "Hi",
    at: 1,
    status: "failed",
    error: "[10003] Unknown Channel",
  };
  await store.putRecord("s", "reminder", "r", reminder as unknown as Json, 0);
  const registry = new ToolRegistry(store, async () => false);
  registerReminderTools(registry, { store, authorize: async () => {} });
  await assert.rejects(
    registry.invokeResult(
      message,
      "reminder",
      { action: "cancel", id: "r" },
      "cancel",
      "agent",
    ),
    /Reminder already failed: \[10003\] Unknown Channel\./,
  );
  const saved = (await store.record("s", "reminder", "r"))!
    .value as unknown as Reminder;
  assert.equal(saved.status, "failed");
});
