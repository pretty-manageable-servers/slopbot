import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Json, Message } from "../src/domain.js";
import { RequestError } from "../src/errors.js";
import type { LlmMode } from "../src/llm-mode.js";
import { ScheduleWorker, type ScheduleWorkerDeps } from "../src/schedules/schedule-worker.js";
import { SCHEDULE_KIND, type Schedule } from "../src/schedules/schedule-types.js";

const server = "s";
const channel = "c";
const owner = "u";
const slot10 = "2026-10-20T10:00:00.000Z";

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "a",
    server,
    channel,
    owner,
    name: "Standup",
    when: { kind: "cron", cron: "0 * * * *", timezone: "UTC" },
    action: { kind: "prompt", text: "Summarize" },
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
    tools: [] as string[],
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
    invokeTool: async name => {
      calls.tools.push(name);
      return "tool done";
    },
    overGrace: async () => calls.over,
    now: () => clock.now,
    ...overrides,
  };
  return { deps, calls };
}

test("pauses prompt schedules on outage", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule());
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  let mode: LlmMode = "fallback";
  const { deps, calls } = fakes(clock, { llmMode: () => mode }, store);
  const worker = new ScheduleWorker(deps);
  await worker.tick();
  await worker.tick();
  assert.equal(calls.prompts.length, 0);
  const saved = await read(store, "a");
  assert.equal(saved.status, "paused");
  assert.equal(saved.pauseReason, "outage");
  assert.equal(saved.nextAt, slot10);
  mode = "offline";
  await worker.tick();
  assert.equal((await read(store, "a")).pauseReason, "outage");
  assert.equal(calls.prompts.length, 0);
});

test("message and tool keep running", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule({ action: { kind: "message", text: "Hello" } }));
  await put(store, schedule({ id: "b", action: { kind: "tool", tool: "lookup", input: {} } }));
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps, calls } = fakes(clock, { llmMode: () => "offline" }, store);
  await new ScheduleWorker(deps).tick();
  assert.deepEqual(calls.tools, ["lookup"]);
  assert.equal(calls.replies.length, 2);
  assert.equal(calls.replies[0]!.text, "<@u> Hello");
  assert.equal(calls.replies[1]!.text, "tool done");
  for (const id of ["a", "b"]) {
    const saved = await read(store, id);
    assert.equal(saved.status, "active");
    assert.equal(saved.pauseReason, undefined);
    assert.equal(saved.nextAt, "2026-10-20T11:00:00.000Z");
  }
});

test("resumes only outage-paused", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule({ status: "paused", pauseReason: "outage" }));
  await put(store, schedule({ id: "b", status: "paused", pauseReason: "owner", nextAt: null }));
  await put(store, schedule({ id: "c", status: "paused", pauseReason: "failures", nextAt: null }));
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps, calls } = fakes(clock, { llmMode: () => "normal" }, store);
  await new ScheduleWorker(deps).tick();
  assert.equal(calls.prompts.length, 0);
  const resumed = await read(store, "a");
  assert.equal(resumed.status, "active");
  assert.equal(resumed.pauseReason, undefined);
  assert.equal(resumed.nextAt, "2026-10-20T11:00:00.000Z");
  assert.equal((await read(store, "b")).status, "paused");
  assert.equal((await read(store, "b")).pauseReason, "owner");
  assert.equal((await read(store, "c")).pauseReason, "failures");
});

test("no catch-up", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule());
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  let mode: LlmMode = "offline";
  const { deps, calls } = fakes(clock, { llmMode: () => mode }, store);
  const worker = new ScheduleWorker(deps);
  await worker.tick();
  clock.now = new Date("2026-10-20T13:30:00.000Z");
  mode = "normal";
  await worker.tick();
  assert.equal(calls.prompts.length, 0);
  assert.equal(calls.replies.length, 1);
  const saved = await read(store, "a");
  assert.equal(saved.status, "active");
  assert.equal(saved.nextAt, "2026-10-20T14:00:00.000Z");
});

test("outage error not counted", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await put(store, schedule({ action: { kind: "tool", tool: "lookup", input: {} } }));
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const { deps } = fakes(clock, {
    invokeTool: async () => {
      throw new RequestError("PROVIDER_HTTP_503", "Model service is down.", "Retry later.");
    },
  }, store);
  const worker = new ScheduleWorker(deps);
  await worker.tick();
  let saved = await read(store, "a");
  assert.equal(saved.status, "active");
  assert.equal(saved.failures, 0);
  assert.equal(saved.retryAt, "2026-10-20T10:01:00.000Z");
  assert.match(saved.lastError ?? "", /PROVIDER_HTTP_503/);
  for (const at of ["2026-10-20T10:01:00.000Z", "2026-10-20T10:02:00.000Z", "2026-10-20T10:03:00.000Z"]) {
    clock.now = new Date(at);
    await worker.tick();
  }
  saved = await read(store, "a");
  assert.equal(saved.status, "active");
  assert.equal(saved.failures, 0);
});
