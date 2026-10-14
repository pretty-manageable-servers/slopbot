import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry } from "../src/tools.js";
import {
  registerReminderTools,
  type Reminder,
} from "../src/productivity/reminders.js";
import type { Message } from "../src/domain.js";

const joinText = "join-text";
const voiceChannel = "voice-channel";
const at = "2026-10-10T00:01:00Z";
const now = Date.parse("2026-10-10T00:00:00Z");

function voiceMessage(): Message {
  return {
    id: "request",
    server: "s",
    channel: voiceChannel,
    author: "u",
    text: "Remind me",
    timestamp: now,
    source: "voice",
  } as unknown as Message;
}

function textMessage(): Message {
  return {
    id: "request",
    server: "s",
    channel: "c",
    author: "u",
    text: "Remind me",
    timestamp: now,
  } as unknown as Message;
}

test("voice reminder is stored on the join channel", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const checked: string[] = [];
  const registry = new ToolRegistry(store, async () => false);
  registerReminderTools(
    registry,
    {
      store,
      authorize: async (_message, channel) => {
        checked.push(channel);
      },
      reminderChannel: (message) =>
        message.source === "voice" ? joinText : undefined,
    },
    () => now,
  );
  const result = await registry.invokeResult(
    voiceMessage(),
    "reminder",
    { action: "create", at, text: "Ship" },
    "voice-create",
    "agent",
  );
  const id = result.text.match(/Reference: (\w+)/)![1]!;
  const reminder = (await store.record("s", "reminder", id))!
    .value as unknown as Reminder;
  assert.equal(reminder.channel, joinText);
  assert.equal(reminder.owner, "u");
  assert.ok(checked.includes(joinText));
});

test("voice reminder with no join channel keeps the voice channel", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const checked: string[] = [];
  const registry = new ToolRegistry(store, async () => false);
  registerReminderTools(
    registry,
    {
      store,
      authorize: async (_message, channel) => {
        checked.push(channel);
      },
      reminderChannel: () => undefined,
    },
    () => now,
  );
  const result = await registry.invokeResult(
    voiceMessage(),
    "reminder",
    { action: "create", at, text: "Ship" },
    "voice-no-join",
    "agent",
  );
  const id = result.text.match(/Reference: (\w+)/)![1]!;
  const reminder = (await store.record("s", "reminder", id))!
    .value as unknown as Reminder;
  assert.equal(reminder.channel, voiceChannel);
  assert.deepEqual([...new Set(checked)], [voiceChannel]);
});

test("text reminder unchanged", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const checked: string[] = [];
  const asked: string[] = [];
  const registry = new ToolRegistry(store, async () => false);
  registerReminderTools(
    registry,
    {
      store,
      authorize: async (_message, channel) => {
        checked.push(channel);
      },
      reminderChannel: (message) => {
        asked.push(message.channel);
        return message.source === "voice" ? joinText : undefined;
      },
    },
    () => now,
  );
  const result = await registry.invokeResult(
    textMessage(),
    "reminder",
    { action: "create", at, text: "Ship" },
    "text-create",
    "agent",
  );
  const id = result.text.match(/Reference: (\w+)/)![1]!;
  const reminder = (await store.record("s", "reminder", id))!
    .value as unknown as Reminder;
  assert.equal(reminder.channel, "c");
  assert.deepEqual(asked, ["c"]);
  assert.deepEqual([...new Set(checked)], ["c"]);
});

test("voice reminder list shows join channel reminders", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registerReminderTools(
    registry,
    {
      store,
      authorize: async () => {},
      reminderChannel: (message) =>
        message.source === "voice" ? joinText : undefined,
    },
    () => now,
  );
  await registry.invokeResult(
    voiceMessage(),
    "reminder",
    { action: "create", at, text: "Ship" },
    "voice-list-create",
    "agent",
  );
  const listed = await registry.invokeResult(
    voiceMessage(),
    "reminder",
    { action: "list" },
    "voice-list",
    "agent",
  );
  assert.match(listed.text, /Ship/);
  assert.match(listed.text, /Reference: /);
  assert.doesNotMatch(listed.text, /No reminders in this channel/);
});

test("voice reminder cancel works", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registerReminderTools(
    registry,
    {
      store,
      authorize: async () => {},
      reminderChannel: (message) =>
        message.source === "voice" ? joinText : undefined,
    },
    () => now,
  );
  const created = await registry.invokeResult(
    voiceMessage(),
    "reminder",
    { action: "create", at, text: "Ship" },
    "voice-cancel-create",
    "agent",
  );
  const id = created.text.match(/Reference: (\w+)/)![1]!;
  const cancelled = await registry.invokeResult(
    voiceMessage(),
    "reminder",
    { action: "cancel", id },
    "voice-cancel",
    "agent",
  );
  assert.match(cancelled.text, /Reminder cancelled\./);
  const reminder = (await store.record("s", "reminder", id))!
    .value as unknown as Reminder;
  assert.equal(reminder.status, "cancelled");
});
