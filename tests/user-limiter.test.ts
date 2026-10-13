import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";
import type { UsageMeter } from "../src/agent-runner.js";
import { loadConfig } from "../src/config.js";
import type { Message, Prompt } from "../src/domain.js";
import { TaskWorker } from "../src/queue.js";
import { ToolRegistry } from "../src/tools.js";
import { UserLimiter, UserLimitError, limitReply } from "../src/user-limiter.js";
import { activePrices, DEFAULT_FALLBACK_PRICE, parseFallbackPrice, parseModelPrices, usageCostMicros } from "../src/usage-cost.js";
import { registerUsageTool } from "../src/usage-tools.js";

const HOUR = 3600000, WEEK = 7 * 24 * HOUR;
const DOLLAR = 1000000;
const limiter = (store: SQLiteStore, fiveHour: number, week: number, grace = 10) => new UserLimiter(store, { fiveHourCostMicros: fiveHour, weekCostMicros: week, gracePercent: grace });
const message = (id: string, extra: Partial<Message> = {}): Message => ({ id, server: "s", channel: "c", author: "alice", text: `request ${id}`, ...extra });
// One micro-dollar per token, so usage payloads read as their cost.
const ONE_MICRO_PER_TOKEN = { input: 1000000, cached_input: 1000000, output: 1000000 };

test("usageCostMicros prices cached input, output and rounds up", () => {
  const prices = { nimbus: { input: 2000000, cached_input: 500000, output: 8000000 } };
  // 600 uncached input at $2/M, 400 cached at $0.50/M, 500 output at $8/M.
  assert.equal(usageCostMicros({ prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } }, "nimbus", prices, DEFAULT_FALLBACK_PRICE), 5400);
  assert.equal(usageCostMicros({ prompt_tokens: 1000, completion_tokens: 0 }, "unpriced", prices, DEFAULT_FALLBACK_PRICE), 10000);
  assert.equal(usageCostMicros({ prompt_tokens: 1 }, "x", {}, { input: 1, cached_input: 1, output: 1 }), 1);
  assert.equal(usageCostMicros({}, "nimbus", prices, DEFAULT_FALLBACK_PRICE), 0);
});

test("price settings merge over defaults, and invalid configuration fails", () => {
  const defaults = { nimbus: { input: 1, cached_input: 1, output: 1 } };
  assert.deepEqual(activePrices({ nimbus: { input: 2, cached_input: 2, output: 2 }, bad: { input: "x" } }, defaults), { nimbus: { input: 2, cached_input: 2, output: 2 } });
  assert.deepEqual(activePrices("nope", defaults), defaults);
  assert.deepEqual(parseModelPrices(undefined, "MODEL_PRICES"), {});
  assert.throws(() => parseModelPrices('{"m":{"input":1}}', "MODEL_PRICES"), /MODEL_PRICES entry m/);
  assert.throws(() => parseFallbackPrice('{"input":0,"cached_input":0,"output":0}', "MODEL_FALLBACK_PRICE"), /non-zero/);
  assert.deepEqual(parseFallbackPrice(undefined, "MODEL_FALLBACK_PRICE"), DEFAULT_FALLBACK_PRICE);
});

test("a window starts at the first spend after the previous window ended", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("s", "u", 60, 0);
  assert.deepEqual(await limits.check("s", "u", 1), { allowed: true });
  await limits.record("s", "u", 60, 1);
  assert.deepEqual(await limits.check("s", "u", 2), { allowed: false, resetAt: 5 * HOUR });
  const later = 9 * HOUR + 123;
  assert.deepEqual(await limits.check("s", "u", later), { allowed: true });
  await limits.record("s", "u", 60, later);
  assert.deepEqual(await limits.usage("s", "u", later + 1), [
    { kind: "5h", spent: 60, limit: 100, resetAt: later + 5 * HOUR, banked: 0 },
    { kind: "week", spent: 180, limit: 0, resetAt: WEEK, banked: 0 },
  ]);
  store.close();
});

test("check refuses at the limit and allows just under it", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("s", "u", 99, 0);
  assert.deepEqual(await limits.check("s", "u", 1), { allowed: true });
  await limits.record("s", "u", 1, 1);
  assert.deepEqual(await limits.check("s", "u", 2), { allowed: false, resetAt: 5 * HOUR });
  store.close();
});

test("either window can refuse, and both windows blocking reports the latest reset", async () => {
  const store = new SQLiteStore();
  const weekOnly = limiter(store, 1000, 100);
  await weekOnly.record("s", "week", 100, 0);
  assert.deepEqual(await weekOnly.check("s", "week", 1), { allowed: false, resetAt: WEEK });
  const both = limiter(store, 100, 100);
  await both.record("s", "both", 100, 0);
  assert.deepEqual(await both.check("s", "both", 1), { allowed: false, resetAt: WEEK });
  store.close();
});

test("0 means no limit for that window, and spend is still shown", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 0, 0);
  await limits.record("s", "u", 10 * DOLLAR, 0);
  assert.deepEqual(await limits.check("s", "u", 1), { allowed: true });
  assert.deepEqual((await limits.usage("s", "u", 1)).map(window => [window.kind, window.spent, window.limit]), [["5h", 10 * DOLLAR, 0], ["week", 10 * DOLLAR, 0]]);
  store.close();
});

test("grace allows a run to pass its limit, and stops tools past limit times (1 + grace)", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0, 10);
  await limits.record("s", "u", 100, 0);
  assert.equal(await limits.overGrace("s", "u", 1), false);
  await limits.record("s", "u", 10, 1);
  assert.equal(await limits.overGrace("s", "u", 2), false);
  await limits.record("s", "u", 1, 2);
  assert.equal(await limits.overGrace("s", "u", 3), true);
  store.close();
});

test("a banked reset clears its window once and leaves the other window alone", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 1000);
  await store.grantResets("s", "u", "5h", 1);
  await limits.record("s", "u", 100, 0);
  assert.deepEqual(await limits.check("s", "u", 1), { allowed: false, resetAt: 5 * HOUR });
  assert.deepEqual((await limits.usage("s", "u", 1))[0], { kind: "5h", spent: 100, limit: 100, resetAt: 5 * HOUR, banked: 1 });
  assert.equal(await limits.useReset("s", "u", "5h"), true);
  assert.deepEqual(await limits.check("s", "u", 2), { allowed: true });
  assert.deepEqual(await limits.usage("s", "u", 2), [
    { kind: "5h", spent: 0, limit: 100, resetAt: null, banked: 0 },
    { kind: "week", spent: 100, limit: 1000, resetAt: WEEK, banked: 0 },
  ]);
  assert.equal(await limits.useReset("s", "u", "5h"), false);
  store.close();
});

test("two concurrent resets of one banked reset cannot both succeed", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await store.grantResets("s", "u", "5h", 1);
  const results = await Promise.all([limits.useReset("s", "u", "5h"), limits.useReset("s", "u", "5h")]);
  assert.deepEqual(results.sort(), [false, true]);
  await assert.rejects(store.grantResets("s", "u", "5h", 0));
  store.close();
});

test("settings override the defaults per server, and invalid settings fall back", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  store.setSetting("s", "user_limit_5h_cost_micros", 50);
  await limits.record("s", "u", 50, 0);
  assert.deepEqual(await limits.check("s", "u", 1), { allowed: false, resetAt: 5 * HOUR });
  await limits.record("t", "u", 50, 0);
  assert.deepEqual(await limits.check("t", "u", 1), { allowed: true });
  store.setSetting("s", "user_limit_5h_cost_micros", "many");
  assert.deepEqual(await limits.check("s", "u", 1), { allowed: true });
  store.close();
});

test("users and servers have separate counters, and resetUserUsage clears one user", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("s", "u", 100, 0);
  assert.deepEqual(await limits.check("s", "v", 1), { allowed: true });
  assert.deepEqual(await limits.check("t", "u", 1), { allowed: true });
  await store.resetUserUsage("s", "u");
  assert.deepEqual(await limits.check("s", "u", 2), { allowed: true });
  store.close();
});

test("the limit reply shows the reset as a Discord relative time", () => {
  assert.equal(limitReply(1700000000500), "Usage limit reached. Try again <t:1700000001:R>.");
  assert.equal(new UserLimitError(42).resetAt, 42);
});

test("the usage tool shows spend and uses a banked reset", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100 * DOLLAR, 0);
  const registry = new ToolRegistry(store, async () => false);
  registerUsageTool(registry, limits);
  await limits.record("s", "alice", 100 * DOLLAR);
  await store.grantResets("s", "alice", "5h", 1);
  const shown = await registry.invokeResult(message("1"), "usage", {}, "usage-show-1", "command");
  assert.match(shown.text, /^5h: \$100\.00 spent of \$100\.00, resets <t:\d+:R>\. Banked resets: 1\./m);
  const reset = await registry.invokeResult(message("2"), "usage", { action: "reset", window: "5h" }, "usage-reset-2", "command");
  assert.match(reset.text, /Used one 5h reset/);
  const after = await registry.invokeResult(message("3"), "usage", {}, "usage-show-3", "command");
  assert.match(after.text, /^5h: \$0\.00 spent of \$100\.00\. Banked resets: 0\./m);
  store.close();
});

test("TaskWorker.enqueue refuses an over-limit user and queues nothing for them", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("s", "alice", 100);
  const worker = new TaskWorker("s", store, limits, async () => undefined, async () => {}, () => true);
  await assert.rejects(worker.enqueue(message("1")), error => error instanceof UserLimitError && error.resetAt > Date.now());
  assert.equal(store.jobs("s", "c").length, 0);
  store.close();
});

test("TaskWorker.enqueue lets bot messages and task seeds through an over-limit user's gate", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("s", "alice", 100);
  const worker = new TaskWorker("s", store, limits, async () => undefined, async () => {}, () => true);
  await worker.enqueue(message("3", { isBot: true }));
  await worker.enqueue(message("task-seed:4"));
  await assert.rejects(worker.enqueue(message("5")), UserLimitError);
  assert.deepEqual(store.jobs("s", "c").map(job => job.message.id).sort(), ["3", "task-seed:4"]);
  store.close();
});

// Runner tests: a fake model that reports usage, and a meter backed by the real limiter.
const call = '{"tool_calls":[{"name":"read","arguments":{}}]}';
const request = { id: "request", server: "s", channel: "c", author: "alice", text: "Do the task", addressed: true };
function meterFor(limits: UserLimiter): UsageMeter {
  return {
    record: (message, payload) => limits.record(message.server, message.author, usageCostMicros(payload, "m", {}, ONE_MICRO_PER_TOKEN)),
    overGrace: message => limits.overGrace(message.server, message.author),
  };
}

test("a run pays for each model call, and past grace it starts no new tool round", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0, 10);
  let toolRuns = 0;
  // Each model call costs 60 micro-dollars.
  const llm = { async *stream() { yield { kind: "text" as const, payload: { text: call } }; yield { kind: "usage" as const, payload: { prompt_tokens: 60, completion_tokens: 0 } }; } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, undefined,
    { tools: { catalog: () => "", execute: async () => { toolRuns++; return "Result"; } }, usage: meterFor(limits) });
  const reply = await app.handle(request);
  // Round 1 starts at 0 spend and runs its tool. Round 2 runs at 60 and its model call takes spend to 120, past 110.
  assert.equal(toolRuns, 1);
  assert.match(reply?.text ?? "", /Usage limit reached during this request/);
  assert.equal((await limits.usage("s", "alice"))[0]?.spent, 120);
  store.close();
});

test("when the user is already past grace, the model answers without tools", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0, 10);
  await limits.record("s", "alice", 200);
  let toolRuns = 0;
  const llm = { async *stream(prompt: Prompt) {
    const stopped = JSON.stringify(prompt.inputs).includes("usage limit");
    yield { kind: "text" as const, payload: { text: stopped ? "Final answer" : call } };
    yield { kind: "usage" as const, payload: { prompt_tokens: 10, completion_tokens: 0 } };
  } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, undefined,
    { tools: { catalog: () => "", execute: async () => { toolRuns++; return "Result"; } }, usage: meterFor(limits) });
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
  assert.match(read("agent-runner.ts"), /this\.services\.usage\?\.record\(/);
  // Jobs are created only through TaskWorker.enqueue, so no other entry point can skip the check.
  for (const file of sourceFiles(src)) {
    if (file.endsWith("/queue.ts")) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /\.enqueueJob\(/, `${file} must go through TaskWorker.enqueue`);
  }
});

test("config reads the cost limits, grace and prices from the environment", () => {
  const base = { DISCORD_BOT_TOKEN: "test", LLM_MODE: "mock" };
  const config = loadConfig(base);
  assert.equal(config.userLimit5hCostMicros, 2000000);
  assert.equal(config.userLimitWeekCostMicros, 20000000);
  assert.equal(config.userLimitGracePercent, 10);
  assert.deepEqual(config.modelPrices, {});
  const priced = loadConfig({ ...base, USER_LIMIT_5H_COST_MICROS: "0", MODEL_PRICES: '{"nimbus":{"input":1,"cached_input":1,"output":2}}' });
  assert.equal(priced.userLimit5hCostMicros, 0);
  assert.deepEqual(priced.modelPrices.nimbus, { input: 1, cached_input: 1, output: 2 });
  assert.throws(() => loadConfig({ ...base, USER_LIMIT_WEEK_COST_MICROS: "-1" }), /USER_LIMIT_WEEK_COST_MICROS/);
});
