import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Json, Message } from "../src/domain.js";
import { ToolError } from "../src/errors.js";
import { ScheduleWorker, type ScheduleWorkerDeps } from "../src/schedules/schedule-worker.js";
import { SCHEDULE_KIND, scheduleMessageId, type Schedule } from "../src/schedules/schedule-types.js";

const server = "s";
const channel = "c";
const owner = "u";
const slot10 = "2026-10-20T10:00:00.000Z";

// Like DiscordAPIError: the error has a numeric `code`.
function discordError(code: number, text: string): Error {
  return Object.assign(new Error(text), { code });
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "a",
    server,
    channel,
    owner,
    name: "Standup",
    when: { kind: "cron", cron: "0 * * * *", timezone: "UTC" },
    action: { kind: "message", text: "Hello" },
    status: "active",
    nextAt: slot10,
    expiresAt: "2026-12-31T00:00:00.000Z",
    failures: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

async function put(store: SQLiteStore, value: Schedule): Promise<void> {
  await store.putRecord(server, SCHEDULE_KIND, value.id, value as unknown as Json, 0);
}

async function read(store: SQLiteStore, id: string): Promise<Schedule> {
  return (await store.record(server, SCHEDULE_KIND, id))!.value as unknown as Schedule;
}

// Fakes for every side effect. Each test overrides only what it needs.
function fakes(clock: { now: Date }, overrides: Partial<ScheduleWorkerDeps> = {}, store: SQLiteStore) {
  const calls = {
    replies: [] as { channel: string; text: string; deliveryId: string }[],
    prompts: [] as Message[],
    tools: [] as { name: string; ctx: { id: string; author: string; channel: string; source: string } }[],
    over: false,
  };
  const deps: ScheduleWorkerDeps = {
    server,
    store,
    authorize: async () => {},
    reply: async (channel, text, deliveryId) => {
      calls.replies.push({ channel, text, deliveryId });
    },
    enqueuePrompt: async message => {
      calls.prompts.push(message);
    },
    invokeTool: async (name, _input, ctx) => {
      calls.tools.push({ name, ctx });
      return "tool done";
    },
    overGrace: async () => calls.over,
    now: () => clock.now,
    ...overrides,
  };
  return { deps, calls };
}

test("message fires once per slot", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule());
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps, calls } = fakes(clock, {}, store);
  const worker = new ScheduleWorker(deps);
  await worker.tick();
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.replies[0]!.text, "<@u> Hello");
  assert.equal(calls.replies[0]!.deliveryId, `schedule:a:${slot10}`);
  await worker.tick();
  assert.equal(calls.replies.length, 1);
  clock.now = new Date("2026-10-20T11:00:00.000Z");
  await worker.tick();
  assert.equal(calls.replies.length, 2);
  assert.equal((await read(store, "a")).nextAt, "2026-10-20T12:00:00.000Z");
});

test("no catch-up after 3 missed slots", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule());
  const clock = { now: new Date("2026-10-20T13:30:00.000Z") };
  const { deps, calls } = fakes(clock, {}, store);
  await new ScheduleWorker(deps).tick();
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.replies[0]!.deliveryId, `schedule:a:${slot10}`);
  assert.equal((await read(store, "a")).nextAt, "2026-10-20T14:00:00.000Z");
});

test("once becomes done", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule({ when: { kind: "once", at: "2026-10-20T10:00:00Z" }, expiresAt: null }));
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps, calls } = fakes(clock, {}, store);
  await new ScheduleWorker(deps).tick();
  assert.equal(calls.replies.length, 1);
  const saved = await read(store, "a");
  assert.equal(saved.status, "done");
  assert.equal(saved.nextAt, null);
});

test("expired posts note", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule({ expiresAt: "2026-10-19T00:00:00.000Z" }));
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps, calls } = fakes(clock, {}, store);
  const worker = new ScheduleWorker(deps);
  await worker.tick();
  await worker.tick();
  const saved = await read(store, "a");
  assert.equal(saved.status, "expired");
  assert.equal(saved.nextAt, null);
  assert.equal(calls.replies.length, 1);
  assert.equal(
    calls.replies[0]!.text,
    "Schedule **Standup** expired (free plan: 30 days). Renew it with the schedule tool.",
  );
});

test("usage over pauses with note", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule({ action: { kind: "prompt", text: "Summarize" } }));
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps, calls } = fakes(clock, {}, store);
  calls.over = true;
  const worker = new ScheduleWorker(deps);
  await worker.tick();
  await worker.tick();
  assert.equal(calls.prompts.length, 0);
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0]!.text, /over your usage limit/);
  const saved = await read(store, "a");
  assert.equal(saved.status, "paused");
  assert.equal(saved.pauseReason, "usage");
  assert.equal(saved.nextAt, slot10);
});

test("third failure pauses", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule({ action: { kind: "tool", tool: "lookup", input: {} } }));
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps, calls } = fakes(clock, {
    invokeTool: async () => {
      throw new Error("boom");
    },
  }, store);
  const worker = new ScheduleWorker(deps);
  await worker.tick();
  let saved = await read(store, "a");
  assert.equal(saved.status, "active");
  assert.equal(saved.failures, 1);
  assert.equal(saved.retryAt, "2026-10-20T10:01:00.000Z");
  clock.now = new Date("2026-10-20T10:00:30.000Z");
  await worker.tick();
  assert.equal((await read(store, "a")).failures, 1);
  clock.now = new Date("2026-10-20T10:01:00.000Z");
  await worker.tick();
  assert.equal((await read(store, "a")).failures, 2);
  clock.now = new Date("2026-10-20T10:02:00.000Z");
  await worker.tick();
  saved = await read(store, "a");
  assert.equal(saved.status, "paused");
  assert.equal(saved.pauseReason, "failures");
  assert.equal(saved.failures, 3);
  assert.match(saved.lastError ?? "", /boom/);
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0]!.text, /paused after 3 failed runs/);
});

test("permanent discord error pauses", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule());
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  let attempts = 0;
  const { deps } = fakes(clock, {
    reply: async () => {
      attempts++;
      throw discordError(50013, "Missing Permissions");
    },
  }, store);
  const worker = new ScheduleWorker(deps);
  await worker.tick();
  clock.now = new Date("2026-10-20T11:00:00.000Z");
  await worker.tick();
  assert.equal(attempts, 1);
  const saved = await read(store, "a");
  assert.equal(saved.status, "paused");
  assert.equal(saved.pauseReason, "permission");
  assert.equal(saved.failures, 0);
  assert.match(saved.lastError ?? "", /Missing Permissions/);
});

test("access error from authorize pauses", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule());
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps, calls } = fakes(clock, {
    authorize: async () => {
      throw new ToolError("Channel is disabled.");
    },
  }, store);
  await new ScheduleWorker(deps).tick();
  assert.equal(calls.replies.length, 0);
  const saved = await read(store, "a");
  assert.equal(saved.status, "paused");
  assert.equal(saved.pauseReason, "permission");
});

test("prompt message id format", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule({ action: { kind: "prompt", text: "Summarize the channel" } }));
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps, calls } = fakes(clock, {}, store);
  await new ScheduleWorker(deps).tick();
  assert.equal(calls.replies.length, 0);
  assert.equal(calls.prompts.length, 1);
  const prompt = calls.prompts[0]!;
  assert.equal(prompt.id, scheduleMessageId("a", slot10));
  assert.equal(prompt.id, `command:schedule:a:${slot10}`);
  assert.equal(prompt.author, owner);
  assert.equal(prompt.channel, channel);
  assert.equal(prompt.text, "Summarize the channel");
  assert.equal(prompt.addressed, true);
});

test("tool result is posted, and no result posts nothing", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule({ action: { kind: "tool", tool: "lookup", input: { q: "x" } } }));
  await put(store, schedule({ id: "b", action: { kind: "tool", tool: "quiet", input: {} } }));
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const contexts: { id: string; author: string; channel: string; source: string }[] = [];
  const { deps, calls } = fakes(clock, {
    invokeTool: async (name, _input, ctx) => {
      contexts.push(ctx);
      return name === "quiet" ? undefined : "tool done";
    },
  }, store);
  await new ScheduleWorker(deps).tick();
  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts[0], { id: scheduleMessageId("a", slot10), author: owner, channel, source: "command" });
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.replies[0]!.text, "tool done");
  assert.equal(calls.replies[0]!.deliveryId, `schedule:a:${slot10}`);
});

test("lease prevents double run", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule());
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  let entered!: () => void;
  const reached = new Promise<void>(resolve => (entered = resolve));
  let posts = 0;
  const slow = fakes(clock, {
    reply: async () => {
      posts++;
      entered();
      await gate;
    },
  }, store);
  const fast = fakes(clock, {
    reply: async () => {
      posts++;
    },
  }, store);
  const first = new ScheduleWorker(slow.deps).tick();
  await reached;
  // A second worker on the same store sees the lease and must skip the schedule.
  await new ScheduleWorker(fast.deps).tick();
  assert.equal(posts, 1);
  release();
  await first;
  assert.equal(posts, 1);
  const saved = await read(store, "a");
  assert.equal(saved.status, "active");
  assert.equal(saved.nextAt, "2026-10-20T11:00:00.000Z");
});

test("record left running after a crash is taken again", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule({ status: "running", retryAt: "2026-10-20T09:00:00.000Z" }));
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps, calls } = fakes(clock, {}, store);
  await new ScheduleWorker(deps).tick();
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.replies[0]!.deliveryId, `schedule:a:${slot10}`);
  const saved = await read(store, "a");
  assert.equal(saved.status, "active");
  assert.equal(saved.nextAt, "2026-10-20T11:00:00.000Z");
});
