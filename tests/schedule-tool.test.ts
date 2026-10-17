import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Json, Message } from "../src/domain.js";
import { registerScheduleTool } from "../src/schedules/schedule-tool.js";
import { SCHEDULE_KIND, SCHEDULE_LIMITS_KEY, type Schedule } from "../src/schedules/schedule-types.js";
import { ToolRegistry, UncertainActionError } from "../src/tools.js";
import { GLOBAL_SETTINGS_SCOPE } from "../src/usage-cost.js";

// Wed 14 Oct 2026, 08:00 UTC. London is on BST (UTC+1) until 25 Oct.
const base = Date.parse("2026-10-14T08:00:00Z");
const DAY = 86_400_000;
const weekly = { kind: "cron", cron: "0 9 * * 1", timezone: "Europe/London" } as const;

function setup(options: { admins?: string[]; team?: string[] } = {}) {
  const store = new SQLiteStore();
  const admins = new Set(options.admins ?? []);
  const team = new Set(options.team ?? []);
  const clock = { t: base };
  const registry = new ToolRegistry(store, async (message) => admins.has(message.author));
  registry.register({
    name: "echo",
    description: "Echo the text",
    fields: { text: { type: "string", description: "Text" } },
    access: "member",
    effect: "read",
    retrySafe: true,
    execution: "inline",
    async execute(_context, args) {
      return String(args.text ?? "");
    },
  });
  registry.register({
    name: "admin_echo",
    description: "Admin only",
    fields: { text: { type: "string", description: "Text" } },
    access: "admin",
    effect: "read",
    retrySafe: true,
    execution: "inline",
    async execute(_context, args) {
      return String(args.text ?? "");
    },
  });
  registerScheduleTool(
    registry,
    { store, authorize: async () => {}, isTeamEditor: (user) => team.has(user) },
    () => clock.t,
  );
  let operation = 0;
  const call = (input: Record<string, Json>, author = "u") => {
    const message: Message = { server: "s", channel: "c", author, id: `request-${operation}`, text: "" };
    return registry.invokeResult(message, "schedule", input, `op-${++operation}`, "agent");
  };
  const saved = async (id: string) => (await store.record("s", SCHEDULE_KIND, id))!;
  const value = async (id: string) => (await saved(id)).value as unknown as Schedule;
  return { store, registry, clock, call, saved, value };
}

const referenceOf = (text: string) => /Reference: (\S+)/.exec(text)![1]!;

async function createWeekly(env: ReturnType<typeof setup>, author = "u", name = "Standup") {
  const result = await env.call({ action: "create", name, when: weekly, run: { kind: "message", text: "Standup time" } }, author);
  return referenceOf(result.text);
}

test("create message cron", async () => {
  const env = setup();
  const result = await env.call({ action: "create", name: "Standup", when: weekly, run: { kind: "message", text: "Standup time" } });
  const id = referenceOf(result.text);
  const schedule = await env.value(id);
  assert.equal(schedule.status, "active");
  assert.equal(schedule.owner, "u");
  assert.equal(schedule.channel, "c");
  assert.deepEqual(schedule.action, { kind: "message", text: "Standup time" });
  // Monday 19 Oct 09:00 London (BST) is 08:00 UTC.
  assert.equal(schedule.nextAt, "2026-10-19T08:00:00.000Z");
  assert.equal(schedule.expiresAt, new Date(base + 30 * DAY).toISOString());
  assert.equal(schedule.failures, 0);
});

test("server cap", async () => {
  const env = setup();
  await env.store.setSetting(GLOBAL_SETTINGS_SCOPE, SCHEDULE_LIMITS_KEY, { perServer: 1 });
  await createWeekly(env, "u");
  await assert.rejects(createWeekly(env, "v"), /This server has reached its schedule limit \(1\)\./);
});

test("user cap", async () => {
  const env = setup();
  await env.store.setSetting(GLOBAL_SETTINGS_SCOPE, SCHEDULE_LIMITS_KEY, { perUser: 1 });
  await createWeekly(env, "u");
  await assert.rejects(createWeekly(env, "u"), /You have reached your schedule limit \(1\)\./);
  await createWeekly(env, "v");
});

test("tool schedule rejected", async () => {
  const env = setup();
  for (const tool of ["schedule", "reminder"]) {
    await assert.rejects(
      env.call({ action: "create", name: "Run", when: weekly, run: { kind: "tool", tool, input: {} } }),
      new RegExp(`cannot call ${tool}\\.`),
    );
  }
});

test("tool the owner cannot access is rejected at create", async () => {
  const env = setup();
  const daily = { kind: "cron", cron: "0 9 * * *", timezone: "UTC" };
  await assert.rejects(
    env.call({ action: "create", name: "Admin", when: daily, run: { kind: "tool", tool: "admin_echo", input: { text: "x" } } }),
    /Manage Server permission is required/,
  );
});

test("cancel by other member denied", async () => {
  const env = setup();
  const id = await createWeekly(env, "u");
  await assert.rejects(env.call({ action: "cancel", id }, "v"), /Only the schedule owner or a Slopbot team member/);
  assert.equal((await env.value(id)).status, "active");
  await env.call({ action: "cancel", id }, "u");
  assert.equal((await env.value(id)).status, "cancelled");
});

test("team member can cancel another member's schedule", async () => {
  const env = setup({ team: ["t"] });
  const id = await createWeekly(env, "u");
  await env.call({ action: "cancel", id }, "t");
  assert.equal((await env.value(id)).status, "cancelled");
});

test("list shows own schedules; team editor sees all", async () => {
  const env = setup({ team: ["t"] });
  await createWeekly(env, "u", "Mine");
  await createWeekly(env, "v", "Theirs");
  const own = await env.call({ action: "list" }, "u");
  assert.match(own.text, /Mine/);
  assert.doesNotMatch(own.text, /Theirs/);
  const all = await env.call({ action: "list" }, "t");
  assert.match(all.text, /Mine/);
  assert.match(all.text, /Theirs/);
});

const retryRequest: Message = { server: "s", channel: "c", author: "u", id: "same-request", text: "Schedule this" };
const retryInput = { action: "create", name: "Once", when: { kind: "once", at: "2026-10-14T09:00:00Z" }, run: { kind: "message", text: "Hi" } };

test("lost create response reconciles a new operation to one persisted reference", async () => {
  const env = setup();
  const put = env.store.putRecord.bind(env.store);
  let lost = true;
  env.store.putRecord = async (...args) => {
    const result = await put(...args);
    if (args[1] === SCHEDULE_KIND && lost) {
      lost = false;
      throw new UncertainActionError("Response lost after commit");
    }
    return result;
  };
  await assert.rejects(env.registry.invokeResult(retryRequest, "schedule", retryInput, "first-create", "agent"), UncertainActionError);
  const [original] = await env.store.records("s", SCHEDULE_KIND);
  assert.ok(original);
  await assert.rejects(env.registry.invokeResult({ ...retryRequest, id: "unrelated-request" }, "schedule", retryInput, "unrelated", "agent"), /did not finish/);
  assert.equal((await env.store.records("s", SCHEDULE_KIND)).length, 1);
  // Replaying must work after the fire time and even when the cap has been reached.
  env.clock.t += DAY;
  await env.store.setSetting(GLOBAL_SETTINGS_SCOPE, SCHEDULE_LIMITS_KEY, { perServer: 1 });
  const result = await env.registry.invokeResult(retryRequest, "schedule", retryInput, "retry-create", "agent");
  assert.equal(referenceOf(result.text), original.id);
  assert.equal((await env.store.records("s", SCHEDULE_KIND)).length, 1);
  assert.equal((await env.value(original.id)).requestId, retryRequest.id);
  const listed = await env.registry.invokeResult(retryRequest, "schedule", { action: "list" }, "list-retry", "agent");
  assert.equal((listed.text.match(/Reference:/g) ?? []).length, 1);
  assert.equal((await env.registry.recordedOperation("first-create"))?.status, "done");
});

test("concurrent registries use one atomic request receipt", async () => {
  const env = setup();
  const other = new ToolRegistry(env.store, async () => false);
  registerScheduleTool(other, { store: env.store, authorize: async () => {}, isTeamEditor: () => false }, () => base);
  const results = await Promise.all([
    env.registry.invokeResult(retryRequest, "schedule", retryInput, "parallel-a", "agent"),
    other.invokeResult(retryRequest, "schedule", retryInput, "parallel-b", "agent"),
  ]);
  assert.equal(referenceOf(results[0]!.text), referenceOf(results[1]!.text));
  assert.equal((await env.store.records("s", SCHEDULE_KIND)).length, 1);
});
