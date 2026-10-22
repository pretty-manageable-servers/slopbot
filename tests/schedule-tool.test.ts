import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Json, Message } from "../src/domain.js";
import { registerScheduleTool } from "../src/schedules/schedule-tool.js";
import { SCHEDULE_KIND, SCHEDULE_LIMITS_KEY, type Schedule } from "../src/schedules/schedule-types.js";
import { ToolRegistry, UncertainActionError } from "../src/tools.js";
import { runToolsCodeTool } from "../src/run-tools-code.js";
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
  assert.equal(result.ui?.type, "card");
  assert.deepEqual(
    result.ui?.type === "card" ? result.ui.actions?.map(action => [action.action, action.arguments]) : undefined,
    [["schedule.pause", { id }], ["schedule.cancel", { id }]],
  );
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

test("prompt interval too short", async () => {
  const env = setup();
  const every30 = { kind: "cron", cron: "*/30 * * * *", timezone: "Europe/London" };
  await assert.rejects(
    env.call({ action: "create", name: "Chat", when: every30, run: { kind: "prompt", text: "Hi" } }),
    /at most once every 60 minutes/,
  );
  // A message run has a 15 minute minimum, so the same cron is allowed.
  await env.call({ action: "create", name: "Chat", when: every30, run: { kind: "message", text: "Hi" } });
});

test("tool unknown rejected", async () => {
  const env = setup();
  await assert.rejects(
    env.call({ action: "create", name: "Run", when: weekly, run: { kind: "tool", tool: "nope", input: {} } }),
    /Unknown tool: nope/,
  );
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

test("tool run stores validated input", async () => {
  const env = setup();
  const daily = { kind: "cron", cron: "0 9 * * *", timezone: "UTC" };
  const result = await env.call({ action: "create", name: "Echo", when: daily, run: { kind: "tool", tool: "echo", input: { text: "hi" } } });
  assert.deepEqual((await env.value(referenceOf(result.text))).action, { kind: "tool", tool: "echo", input: { text: "hi" } });
  await assert.rejects(
    env.call({ action: "create", name: "Echo", when: daily, run: { kind: "tool", tool: "echo", input: { bogus: 1 } } }),
    /Unknown argument: bogus/,
  );
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

test("renew expired", async () => {
  const env = setup();
  const id = await createWeekly(env, "u");
  // The worker marks a schedule expired after 30 days. Set that state directly here.
  const record = await env.saved(id);
  const expired = { ...(record.value as unknown as Schedule), status: "expired", nextAt: null } as unknown as Json;
  await env.store.putRecord("s", SCHEDULE_KIND, id, expired, record.revision);
  env.clock.t = base + 31 * DAY;
  await env.call({ action: "renew", id });
  const schedule = await env.value(id);
  assert.equal(schedule.status, "active");
  assert.equal(schedule.expiresAt, new Date(env.clock.t + 30 * DAY).toISOString());
  assert.equal(schedule.renewedAt, new Date(env.clock.t).toISOString());
  assert.ok(schedule.nextAt && Date.parse(schedule.nextAt) > env.clock.t);
});

test("renew refused for one-time schedule", async () => {
  const env = setup();
  const result = await env.call({ action: "create", name: "Once", when: { kind: "once", at: "2026-10-20T09:00:00Z" }, run: { kind: "message", text: "Hi" } });
  await assert.rejects(env.call({ action: "renew", id: referenceOf(result.text) }), /Only recurring schedules expire/);
});

test("resume resets failures", async () => {
  const env = setup();
  const id = await createWeekly(env, "u");
  const record = await env.saved(id);
  const paused = { ...(record.value as unknown as Schedule), status: "paused", pauseReason: "failures", failures: 3, nextAt: null } as unknown as Json;
  await env.store.putRecord("s", SCHEDULE_KIND, id, paused, record.revision);
  await env.call({ action: "resume", id });
  const schedule = await env.value(id);
  assert.equal(schedule.status, "active");
  assert.equal(schedule.failures, 0);
  assert.equal(schedule.pauseReason, undefined);
  assert.equal(schedule.nextAt, "2026-10-19T08:00:00.000Z");
});

test("pause then resume", async () => {
  const env = setup();
  const id = await createWeekly(env, "u");
  await env.call({ action: "pause", id });
  const paused = await env.value(id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseReason, "owner");
  assert.equal(paused.nextAt, null);
  await assert.rejects(env.call({ action: "pause", id }), /Only an active schedule can be paused/);
  await env.call({ action: "resume", id });
  assert.equal((await env.value(id)).status, "active");
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

test("cancelled schedule cannot be cancelled again", async () => {
  const env = setup();
  const id = await createWeekly(env, "u");
  await env.call({ action: "cancel", id });
  await assert.rejects(env.call({ action: "cancel", id }), /already cancelled/);
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

test("lost journal acknowledgement replays the same operation without rewriting the schedule", async () => {
  const env = setup();
  const end = env.store.endOperation.bind(env.store);
  let lost = true;
  env.store.endOperation = async (...args) => {
    if (lost) { lost = false; throw new Error("Journal acknowledgement lost"); }
    await end(...args);
  };
  await assert.rejects(env.registry.invokeResult(retryRequest, "schedule", retryInput, "same-operation", "agent"), /acknowledgement lost/);
  const result = await env.registry.invokeResult(retryRequest, "schedule", retryInput, "same-operation", "agent");
  assert.equal((await env.saved(referenceOf(result.text))).revision, 1);
  assert.equal((await env.store.records("s", SCHEDULE_KIND)).length, 1);
});

test("interruption during create validation rejects without writing a row", async () => {
  const env = setup();
  const controller = new AbortController();
  const records = env.store.records.bind(env.store);
  env.store.records = async (...args) => {
    const result = await records(...args);
    controller.abort();
    return result;
  };
  let writes = 0;
  const put = env.store.putRecord.bind(env.store);
  env.store.putRecord = async (...args) => { writes++; return put(...args); };
  await assert.rejects(env.registry.invokeResult(retryRequest, "schedule", retryInput, "interrupted", "agent", undefined, { signal: controller.signal }), /interrupted/);
  assert.equal(writes, 0);
  assert.equal((await records("s", SCHEDULE_KIND)).length, 0);
  assert.equal((await env.registry.recordedOperation("interrupted"))?.status, "failed");
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

test("distinct creates in one request and identical creates in separate requests are preserved", async () => {
  const env = setup();
  const invoke = (message: Message, input: unknown, op: string) => env.registry.invokeResult(message, "schedule", input, op, "agent");
  const first = await invoke(retryRequest, retryInput, "distinct-a");
  const different = await invoke(retryRequest, { ...retryInput, name: "Second" }, "distinct-b");
  const next = await invoke({ ...retryRequest, id: "another-request" }, retryInput, "distinct-c");
  assert.equal(new Set([first, different, next].map(result => referenceOf(result.text))).size, 3);
});

test("program create, retry and list report success with one schedule", async () => {
  const env = setup();
  env.registry.register(runToolsCodeTool(env.registry));
  const input = JSON.stringify(retryInput);
  // schedule is a direct tool, so a program cannot call it. The program fails with the direct-tool error.
  const refused = await env.registry.invokeResult(retryRequest, "run_tools_code", { code: `return await tools.schedule(${input});` }, "program", "agent");
  assert.match(refused.text, /schedule is a direct tool\. Call it outside run_tools_code\./);
  assert.equal((await env.store.records("s", SCHEDULE_KIND)).length, 0);
  // The same three calls, made directly, report success with one schedule.
  await env.registry.invokeResult(retryRequest, "schedule", retryInput, "first", "agent");
  await env.registry.invokeResult(retryRequest, "schedule", retryInput, "retry", "agent");
  const list = await env.registry.invokeResult(retryRequest, "schedule", { action: "list" }, "list", "agent");
  assert.doesNotMatch(list.text, /rejected|handoff or UI/);
  assert.equal((await env.store.records("s", SCHEDULE_KIND)).length, 1);
});
