import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";

import type { Message, Prompt } from "../src/domain.js";
import { TaskWorker } from "../src/queue.js";

import { USER_LIMIT_OVERRIDES_SETTING, UserLimiter, UserLimitError } from "../src/user-limiter.js";
import { DEFAULT_FALLBACK_PRICE, usageCostMicros } from "../src/usage-cost.js";

import { attribution, UsageMeter } from "../src/usage-meter.js";

const HOUR = 3600000, WEEK = 7 * 24 * HOUR;
const DOLLAR = 1000000;
const limiter = (store: SQLiteStore, fiveHour: number, week: number, grace = 10) => new UserLimiter(store, { fiveHourCostMicros: fiveHour, weekCostMicros: week, gracePercent: grace });
const message = (id: string, extra: Partial<Message> = {}): Message => ({ id, server: "s", channel: "c", author: "alice", text: `request ${id}`, ...extra });
// One micro-dollar per token, so usage payloads read as their cost.
const ONE_MICRO_PER_TOKEN = { input: 1000000, cached_input: 1000000, output: 1000000 };

const call = [{ name: "read", arguments: {} }];
const request = { id: "request", server: "s", channel: "c", author: "alice", text: "Do the task", addressed: true };
function meterFor(limits: UserLimiter): UsageMeter {
  return new UsageMeter(limits, () => ({}), ONE_MICRO_PER_TOKEN);
}
const spentBy = async (limits: UserLimiter, user = "alice") => (await limits.usage(user))[0]?.spent;

test("usageCostMicros prices cached input, output and rounds up", () => {
  const prices = { nimbus: { input: 2000000, cached_input: 500000, output: 8000000 } };
  // 600 uncached input at $2/M, 400 cached at $0.50/M, 500 output at $8/M.
  assert.equal(usageCostMicros({ prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } }, "nimbus", prices, DEFAULT_FALLBACK_PRICE), 5400);
  assert.equal(usageCostMicros({ prompt_tokens: 1000, completion_tokens: 0 }, "unpriced", prices, DEFAULT_FALLBACK_PRICE), 10000);
  assert.equal(usageCostMicros({ prompt_tokens: 1 }, "x", {}, { input: 1, cached_input: 1, output: 1 }), 1);
  assert.equal(usageCostMicros({}, "nimbus", prices, DEFAULT_FALLBACK_PRICE), 0);
});

test("check refuses at the limit and allows just under it", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("u", 99, 0);
  assert.deepEqual(await limits.check("u", 1), { allowed: true });
  await limits.record("u", 1, 1);
  assert.deepEqual(await limits.check("u", 2), { allowed: false, resetAt: 5 * HOUR });
  store.close();
});

test("grace allows a run to pass its limit, and stops tools past limit times (1 + grace)", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0, 10);
  await limits.record("u", 100, 0);
  assert.equal(await limits.overGrace("u", 1), false);
  await limits.record("u", 10, 1);
  assert.equal(await limits.overGrace("u", 2), false);
  await limits.record("u", 1, 2);
  assert.equal(await limits.overGrace("u", 3), true);
  store.close();
});

test("a banked reset clears its window once and leaves the other window alone", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 1000);
  await store.grantResets("global", "u", "5h", 1);
  await limits.record("u", 100, 0);
  assert.deepEqual(await limits.check("u", 1), { allowed: false, resetAt: 5 * HOUR });
  assert.deepEqual((await limits.usage("u", 1))[0], { kind: "5h", spent: 100, limit: 100, resetAt: 5 * HOUR, banked: 1 });
  assert.equal(await limits.useReset("u", "5h"), true);
  assert.deepEqual(await limits.check("u", 2), { allowed: true });
  assert.deepEqual(await limits.usage("u", 2), [
    { kind: "5h", spent: 0, limit: 100, resetAt: null, banked: 0 },
    { kind: "week", spent: 100, limit: 1000, resetAt: WEEK, banked: 0 },
  ]);
  assert.equal(await limits.useReset("u", "5h"), false);
  store.close();
});

test("two concurrent resets of one banked reset cannot both succeed", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await store.grantResets("global", "u", "5h", 1);
  const results = await Promise.all([limits.useReset("u", "5h"), limits.useReset("u", "5h")]);
  assert.deepEqual(results.sort(), [false, true]);
  await assert.rejects(store.grantResets("global", "u", "5h", 0));
  store.close();
});

test("an override replaces the global limit and 0 means no limit", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 500);
  store.setSetting("global", USER_LIMIT_OVERRIDES_SETTING, {
    alice: { five_hour_cost_micros: 1000, week_cost_micros: null },
    bob: { five_hour_cost_micros: 0, week_cost_micros: 0 },
  });
  await limits.record("alice", 200, 0);
  assert.deepEqual(await limits.check("alice", 1), { allowed: true });
  assert.deepEqual((await limits.usage("alice", 1)).map(window => window.limit), [1000, 500], "a null window keeps the global limit");
  await limits.record("alice", 800, 0);
  assert.equal((await limits.check("alice", 1)).allowed, false);
  await limits.record("bob", 1000000, 0);
  assert.deepEqual(await limits.check("bob", 1), { allowed: true });
  assert.deepEqual((await limits.usage("bob", 1)).map(window => window.limit), [0, 0]);
  await limits.record("carol", 100, 0);
  assert.deepEqual(await limits.check("carol", 1), { allowed: false, resetAt: 5 * HOUR });
  assert.deepEqual((await limits.usage("carol", 1)).map(window => window.limit), [100, 500]);
  store.close();
});

test("TaskWorker.enqueue refuses an over-limit user and queues nothing for them", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("alice", 100);
  const worker = new TaskWorker("s", store, limits, async () => undefined, async () => {}, () => true);
  await assert.rejects(worker.enqueue(message("1")), error => error instanceof UserLimitError && error.resetAt > Date.now());
  assert.equal(store.jobs("s", "c").length, 0);
  store.close();
});

test("a run pays for each model call, and past grace it starts no new tool round", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0, 10);
  let toolRuns = 0;
  // Each model call costs 60 micro-dollars.
  const llm = { async *stream() { yield { kind: "tool_call" as const, payload: call }; yield { kind: "usage" as const, payload: { prompt_tokens: 60, completion_tokens: 0 } }; } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, undefined,
    { tools: { schemas: () => [], catalog: () => "", execute: async () => { toolRuns++; return "Result"; } }, usage: meterFor(limits) });
  const reply = await app.handle(request);
  // Round 1 starts at 0 spend and runs its tool. Round 2 runs at 60 and its model call takes spend to 120, past 110.
  assert.equal(toolRuns, 1);
  assert.match(reply?.text ?? "", /Usage limit reached during this request/);
  assert.equal((await limits.usage("alice"))[0]?.spent, 120);
  store.close();
});

test("when the user is already past grace, the model answers without tools", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0, 10);
  await limits.record("alice", 200);
  let toolRuns = 0;
  const llm = { async *stream(prompt: Prompt) {
    const stopped = JSON.stringify(prompt.inputs).includes("usage limit");
    yield stopped ? { kind: "text" as const, payload: { text: "Final answer" } } : { kind: "tool_call" as const, payload: call };
    yield { kind: "usage" as const, payload: { prompt_tokens: 10, completion_tokens: 0 } };
  } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, undefined,
    { tools: { schemas: () => [], catalog: () => "", execute: async () => { toolRuns++; return "Result"; } }, usage: meterFor(limits) });
  assert.equal((await app.handle(request))?.text, "Final answer");
  assert.equal(toolRuns, 0);
  store.close();
});

// Entry points: every place where user input starts work must check the limiter first.
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : name.endsWith(".ts") ? [path] : [];
  });
}

test("entry points check the user limiter before work starts", () => {
  // Tests run from dist/tests, so the TypeScript sources are two levels up.
  const src = fileURLToPath(new URL("../../src/", import.meta.url));
  const read = (path: string) => readFileSync(join(src, path), "utf8");
  assert.match(read("queue.ts"), /this\.limiter\.check\(/);
  const discord = read("adapters/discord.ts");
  assert.match(discord, /this\.limiter\.check\(/);
  assert.ok(discord.indexOf("this.limiter.check(") < discord.indexOf("this.tools.invokeResult(message, name, args, `command:"), "slash commands must check before invoking the tool");
  // /usage is the one exempt entry point: read-only, so it never checks the gate. Its reply builder must not either.
  const usageStart = discord.indexOf("private async usageCommand(");
  const usageBody = discord.slice(usageStart, discord.indexOf("private async command(", usageStart));
  assert.ok(usageStart > 0 && usageBody.includes("usageReply(this.limiter"), "/usage must reply through usageReply");
  assert.doesNotMatch(usageBody, /limiter\.check\(/, "/usage is exempt from the limiter gate");
  assert.doesNotMatch(read("adapters/discord-commands.ts"), /limiter\.check\(/, "usageReply must not check the limiter gate");
  // A private chat message is checked before it is saved, so a refused message never reaches the store.
  const chats = read("web-chats.ts");
  assert.match(chats, /this\.host\.limiter\.check\(/, "a private chat message must check the limiter");
  assert.ok(chats.indexOf("this.host.limiter.check(") < chats.indexOf("await this.store.ingest(message)"), "the private chat limiter check must come before the message is saved");
  assert.match(read("agent-runner.ts"), /streamMetered\(this\.llm, prompt, \{ usage: this\.services\.usage, who: attribution\(message\)/);
  assert.match(read("participation.ts"), /streamMetered\(this\.llm, prompt, \{ usage: this\.usage, who: attribution\(message\) \}\)/);
  assert.match(read("files.ts"), /streamMetered\(options\.llm, prompt, \{ usage: options\.usage/);
  assert.match(read("search/reports.ts"), /streamMetered\(services\.llm, prompt, \{ usage: services\.usage/);
  assert.match(read("adapters/decisions.ts"), /options\.usage\?\.record\(attribution\(message\)/);
  // Jobs are created only through TaskWorker.enqueue, so no other entry point can skip the check.
  for (const file of sourceFiles(src)) {
    if (file.endsWith("/queue.ts")) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /\.enqueueJob\(/, `${file} must go through TaskWorker.enqueue`);
  }
});

test("bot messages are not charged for their model calls", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 0, 0);
  const meter = new UsageMeter(limits, () => ({ nimbus: ONE_MICRO_PER_TOKEN }), ONE_MICRO_PER_TOKEN);
  const llm = { model: "nimbus", async *stream() {
    yield { kind: "text" as const, payload: { text: "Hello" } };
    yield { kind: "usage" as const, payload: { prompt_tokens: 100, completion_tokens: 0 } };
  } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, undefined, { usage: meter });
  assert.equal(attribution({ ...request, isBot: true }), undefined);
  await app.handle({ ...request, isBot: true });
  await meter.record(attribution({ ...request, isBot: true }), "nimbus", { prompt_tokens: 100 });
  assert.equal(await spentBy(limits), 0);
  store.close();
});

test("one limit covers a user in all servers, and old rows for each server merge on open", async () => {
  const dir = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "limits-"));
  const file = join(dir, "db.sqlite");
  const now = Date.now();
  const before = new SQLiteStore(file);
  // Rows as the old code wrote them: one counter set for each server.
  await before.updateUserLimits("s1", "alice", () => ({ windows: [{ kind: "5h", windowStart: now - HOUR, spent: 2 * DOLLAR }, { kind: "week", windowStart: now - 2 * HOUR, spent: 2 * DOLLAR }], result: undefined }));
  await before.updateUserLimits("s2", "alice", () => ({ windows: [{ kind: "5h", windowStart: now - 6 * HOUR, spent: 9 * DOLLAR }, { kind: "week", windowStart: now - 3 * HOUR, spent: 3 * DOLLAR }], result: undefined }));
  await before.grantResets("s1", "alice", "5h", 1);
  await before.grantResets("s2", "alice", "5h", 2);
  before.close();
  const store = new SQLiteStore(file);
  assert.deepEqual((await store.userUsage("s1", "alice")).windows, [], "no rows stay for each server");
  const shared = limiter(store, 4 * DOLLAR, 100 * DOLLAR);
  const usage = await shared.usage("alice", now);
  // The ended 5h window in s2 is dropped; the week windows add up and keep the earliest start.
  assert.deepEqual(usage.map(window => [window.kind, window.spent, window.resetAt, window.banked]), [["5h", 2 * DOLLAR, now - HOUR + 5 * HOUR, 3], ["week", 5 * DOLLAR, now - 3 * HOUR + WEEK, 0]]);
  await shared.record("alice", 2 * DOLLAR, now);
  assert.equal((await shared.check("alice", now)).allowed, false, "spend in one server blocks the user in another");
  assert.equal((await shared.check("bob", now)).allowed, true);
  assert.equal(await shared.useReset("alice", "5h"), true);
  assert.equal((await shared.check("alice", now)).allowed, true);
});
