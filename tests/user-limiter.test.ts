import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";
import type { Message, Prompt } from "../src/domain.js";
import { TaskWorker } from "../src/queue.js";
import { USER_LIMIT_OVERRIDES_SETTING, UserLimiter, UserLimitError, usageView } from "../src/user-limiter.js";
import { DEFAULT_FALLBACK_PRICE } from "../src/usage-cost.js";
import { ProviderEmbeddings } from "../src/adapters/embeddings.js";
import { DecisionClassifier } from "../src/adapters/decisions.js";
import { ByteTokenCounter } from "../src/context.js";
import { inspectFile } from "../src/files.js";
import { attribution, DECISION_OUTPUT_TOKENS, streamMetered, UsageMeter } from "../src/usage-meter.js";

const HOUR = 3600000, WEEK = 7 * 24 * HOUR;
const DOLLAR = 1000000;
const limiter = (store: SQLiteStore, fiveHour: number, week: number, grace = 10) => new UserLimiter(store, { fiveHourCostMicros: fiveHour, weekCostMicros: week, gracePercent: grace });
const message = (id: string, extra: Partial<Message> = {}): Message => ({ id, server: "s", channel: "c", author: "alice", text: `request ${id}`, ...extra });
// One micro-dollar per token, so usage payloads read as their cost.
const ONE_MICRO_PER_TOKEN = { input: 1000000, cached_input: 1000000, output: 1000000 };

test("a window starts at the first spend after the previous window ended", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("u", 60, 0);
  assert.deepEqual(await limits.check("u", 1), { allowed: true });
  await limits.record("u", 60, 1);
  assert.deepEqual(await limits.check("u", 2), { allowed: false, resetAt: 5 * HOUR });
  const later = 9 * HOUR + 123;
  assert.deepEqual(await limits.check("u", later), { allowed: true });
  await limits.record("u", 60, later);
  assert.deepEqual(await limits.usage("u", later + 1), [
    { kind: "5h", spent: 60, limit: 100, resetAt: later + 5 * HOUR, banked: 0 },
    { kind: "week", spent: 180, limit: 0, resetAt: WEEK, banked: 0 },
  ]);
  store.close();
});

test("check refuses at the limit and allows just under it", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("u", 99, 0);
  assert.deepEqual(await limits.check("u", 1), { allowed: true });
  await limits.record("u", 1, 1);
  assert.deepEqual(await limits.check("u", 2), { allowed: false, resetAt: 5 * HOUR });
  store.close();
});

test("either window can refuse, and both windows blocking reports the latest reset", async () => {
  const store = new SQLiteStore();
  const weekOnly = limiter(store, 1000, 100);
  await weekOnly.record("week", 100, 0);
  assert.deepEqual(await weekOnly.check("week", 1), { allowed: false, resetAt: WEEK });
  const both = limiter(store, 100, 100);
  await both.record("both", 100, 0);
  assert.deepEqual(await both.check("both", 1), { allowed: false, resetAt: WEEK });
  store.close();
});

test("0 means no limit for that window, and spend is still shown", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 0, 0);
  await limits.record("u", 10 * DOLLAR, 0);
  assert.deepEqual(await limits.check("u", 1), { allowed: true });
  assert.deepEqual((await limits.usage("u", 1)).map(window => [window.kind, window.spent, window.limit]), [["5h", 10 * DOLLAR, 0], ["week", 10 * DOLLAR, 0]]);
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

test("a banked week reset is a full reset: it clears the 5-hour and weekly windows", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 1000);
  await store.grantResets("global", "u", "week", 1);
  await limits.record("u", 100, 0);
  assert.equal(await limits.useReset("u", "week"), true);
  assert.deepEqual(await limits.usage("u", 1), [
    { kind: "5h", spent: 0, limit: 100, resetAt: null, banked: 0 },
    { kind: "week", spent: 0, limit: 1000, resetAt: null, banked: 0 },
  ]);
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

test("global settings override the defaults, settings for one server are ignored, and invalid settings fall back", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  store.setSetting("s", "user_limit_5h_cost_micros", 10);
  store.setSetting("global", "user_limit_5h_cost_micros", 50);
  await limits.record("u", 49, 0);
  assert.deepEqual(await limits.check("u", 1), { allowed: true });
  await limits.record("u", 1, 0);
  assert.deepEqual(await limits.check("u", 1), { allowed: false, resetAt: 5 * HOUR });
  store.setSetting("global", "user_limit_5h_cost_micros", "many");
  assert.deepEqual(await limits.check("u", 1), { allowed: true });
  store.close();
});

test("users have separate counters, and resetUserUsage clears one user", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("u", 100, 0);
  assert.deepEqual(await limits.check("v", 1), { allowed: true });
  assert.deepEqual(await limits.check("u", 1), { allowed: false, resetAt: 5 * HOUR });
  await store.resetUserUsage("global", "u");
  assert.deepEqual(await limits.check("u", 2), { allowed: true });
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

test("clearing an override restores the global limit, and invalid override fields fall back to it", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  store.setSetting("global", USER_LIMIT_OVERRIDES_SETTING, { alice: { five_hour_cost_micros: 1000, week_cost_micros: null } });
  await limits.record("alice", 500, 0);
  assert.deepEqual(await limits.check("alice", 1), { allowed: true });
  store.setSetting("global", USER_LIMIT_OVERRIDES_SETTING, {});
  assert.deepEqual((await limits.usage("alice", 1)).map(window => window.limit), [100, 0]);
  assert.deepEqual(await limits.check("alice", 1), { allowed: false, resetAt: 5 * HOUR });
  store.setSetting("global", USER_LIMIT_OVERRIDES_SETTING, { alice: { five_hour_cost_micros: 1.5, week_cost_micros: -1 } });
  assert.deepEqual((await limits.usage("alice", 1)).map(window => window.limit), [100, 0]);
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

test("TaskWorker.enqueue lets bot messages and task seeds through an over-limit user's gate", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 100, 0);
  await limits.record("alice", 100);
  const worker = new TaskWorker("s", store, limits, async () => undefined, async () => {}, () => true);
  await worker.enqueue(message("3", { isBot: true }));
  await worker.enqueue(message("task-seed:4"));
  await assert.rejects(worker.enqueue(message("5")), UserLimitError);
  assert.deepEqual(store.jobs("s", "c").map(job => job.message.id).sort(), ["3", "task-seed:4"]);
  store.close();
});

// Runner tests: a fake model that reports usage, and a meter backed by the real limiter.
const call = [{ name: "read", arguments: {} }];
const request = { id: "request", server: "s", channel: "c", author: "alice", text: "Do the task", addressed: true };
function meterFor(limits: UserLimiter): UsageMeter {
  return new UsageMeter(limits, () => ({}), ONE_MICRO_PER_TOKEN);
}

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

// Model calls made outside a reply are charged to the user whose message caused them.
const prompt: Prompt = { prefixVersion: "test", prefix: [], history: [], inputs: [] };
const payer = { server: "s", user: "alice" };
const spentBy = async (limits: UserLimiter, user = "alice") => (await limits.usage(user))[0]?.spent;

test("JEV decisions are charged to the message author at the JEV model price", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 0, 0);
  // The JEV price is output only, so only the answer size is charged. Any other price would give a different total.
  const meter = new UsageMeter(limits, () => ({ vane: { input: 0, cached_input: 0, output: DOLLAR }, nimbus: { input: 100 * DOLLAR, cached_input: 100 * DOLLAR, output: 100 * DOLLAR } }), DEFAULT_FALLBACK_PRICE);
  const classifier = new DecisionClassifier({ baseUrl: "https://example.test", apiKey: "test", model: "vane", usage: meter }, store,
    async () => Response.json({ answers: { addressed: { probabilities: { yes: 0.1 } }, respond: { probabilities: { yes: 0.1 } } } }));
  await classifier.classify(message("jev"), []);
  assert.equal(await spentBy(limits), DECISION_OUTPUT_TOKENS);
  store.close();
});

test("file inspection is charged to the member who asked, at the model price", async t => {
  const store = new SQLiteStore(), limits = limiter(store, 0, 0); t.after(() => store.close());
  const meter = new UsageMeter(limits, () => ({ nimbus: { input: DOLLAR, cached_input: DOLLAR, output: 2 * DOLLAR } }), DEFAULT_FALLBACK_PRICE);
  const llm = { model: "nimbus", async *stream() {
    yield { kind: "text" as const, payload: { text: "A file." } };
    yield { kind: "usage" as const, payload: { prompt_tokens: 10, completion_tokens: 5 } };
  } };
  const inspect = message("inspect", { text: "What is this?" });
  await store.ingest(inspect);
  const text = await inspectFile({ store, llm, usage: meter, decoder: { read: async () => ({ text: "contents", images: [] }) } },
    { message: inspect, operationId: "inspect-op", isAdmin: false, source: "agent", toolName: "file_store", arguments: {}, resource: null, assertActive: async () => {} },
    "notes.txt", "text/plain", new Uint8Array(), "What is this?");
  assert.equal(text, "A file.");
  assert.equal(await spentBy(limits), 10 * 1 + 5 * 2);
});

test("embedding calls are priced as input, charged to the requester, and skipped without a payer", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 0, 0);
  const meter = new UsageMeter(limits, () => ({ "embedding-test": { input: DOLLAR, cached_input: DOLLAR, output: 100 * DOLLAR } }), DEFAULT_FALLBACK_PRICE);
  const reported = new ProviderEmbeddings("https://example.test", "test", "embedding-test", async () => Response.json({ data: [{ embedding: [1, 2] }], usage: { prompt_tokens: 7, total_tokens: 7 } }));
  reported.attachUsage(meter);
  await reported.embedWithUsage("hello", payer);
  assert.equal(await spentBy(limits), 7);
  // Without usage in the response, the sent text is estimated as input.
  const unreported = () => new ProviderEmbeddings("https://example.test", "test", "embedding-test", async () => Response.json({ data: [{ embedding: [1, 2] }] }));
  const estimate = new ByteTokenCounter().count([{ role: "user", content: "hello" }]);
  const second = unreported();
  second.attachUsage(meter);
  await second.embedWithUsage("hello", payer);
  assert.equal(await spentBy(limits), 7 + estimate);
  // Without a payer, such as a bot message or a background job, nothing is charged.
  const third = unreported();
  third.attachUsage(meter);
  await third.embedWithUsage("hello");
  assert.equal(await spentBy(limits), 7 + estimate);
  store.close();
});

test("a reply is charged at the reply model price", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 0, 0);
  const meter = new UsageMeter(limits, () => ({ nimbus: { input: 2 * DOLLAR, cached_input: 0, output: 3 * DOLLAR }, vane: { input: 0, cached_input: 0, output: 0 } }), DEFAULT_FALLBACK_PRICE);
  const llm = { model: "nimbus", async *stream() {
    yield { kind: "text" as const, payload: { text: "Hello" } };
    yield { kind: "usage" as const, payload: { prompt_tokens: 5, completion_tokens: 5 } };
  } };
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, undefined, { usage: meter });
  assert.equal((await app.handle({ ...request, text: "Hi" }))?.text, "Hello");
  assert.equal(await spentBy(limits), 5 * 2 + 5 * 3);
  store.close();
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

test("an unpriced model is charged the fallback price, including a model that names no id", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 0, 0);
  const fallback = { input: 2 * DOLLAR, cached_input: 2 * DOLLAR, output: 2 * DOLLAR };
  const meter = new UsageMeter(limits, () => ({ nimbus: ONE_MICRO_PER_TOKEN }), fallback);
  await meter.record(payer, "mystery", { prompt_tokens: 10 });
  assert.equal(await spentBy(limits), 20);
  // An LLM with no model id is priced under the unknown model id, which has no price, so the fallback applies.
  const unnamed = { async *stream() { yield { kind: "usage" as const, payload: { prompt_tokens: 10 } }; } };
  for await (const event of streamMetered(unnamed, prompt, { usage: meter, who: payer })) void event;
  assert.equal(await spentBy(limits), 40);
  store.close();
});

test("a model stream with no usage is charged the estimate: no input plus the full output budget", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 0, 0);
  // Prices are per million tokens, so the 1000 estimated output tokens at 2 per token cost 2000 micro-dollars.
  const meter = new UsageMeter(limits, () => ({}), { input: DOLLAR, cached_input: DOLLAR, output: 2 * DOLLAR });
  const silent = { model: "nimbus", outputTokenLimit: 1000, async *stream() { yield { kind: "text" as const, payload: { text: "No usage" } }; } };
  for await (const event of streamMetered(silent, prompt, { usage: meter, who: payer })) void event;
  assert.equal(await spentBy(limits), 2000);
  store.close();
});

test("the usage meter view has percents and reset times only, with no cost or limit amounts", async () => {
  const store = new SQLiteStore(":memory:");
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 1000000, weekCostMicros: 0, gracePercent: 10 });
  await limiter.record("u", 2500000, 1000);
  const view = usageView(await limiter.usage("u", 1000));
  assert.equal(view.plan, "Seed");
  // Over the 5-hour limit: capped at 100. No weekly limit: percent is null, not a number.
  assert.deepEqual(view.windows.map(window => [window.kind, window.percent]), [["5h", 100], ["week", null]]);
  assert.deepEqual(view.windows.map(window => window.resetAt), [1000 + 5 * 3600000, 1000 + 7 * 86400000]);
  const keys = JSON.stringify(view);
  assert.doesNotMatch(keys, /cost|spent|limit|micro|dollar|price|\$/i);
  assert.equal(usageView([{ kind: "5h", spent: 333, limit: 1000, resetAt: null, banked: 0 }]).windows[0]!.percent, 33);
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

test("listKnownUsers merges servers, adds web-only users, searches names and IDs, pages and sorts by 5h spend", async () => {
  const store = new SQLiteStore(), limits = limiter(store, 0, 0);
  store.identifyAuthor("s1", "100", ["Alice", "ali"]);
  store.identifyAuthor("s2", "100", ["Alice A"]);
  store.identifyAuthor("s1", "200", ["Bob"]);
  store.identifyAuthor("s1", "700", ["Amy"]);
  store.identifyAuthor("s1", "400", ["Robot"], true);
  store.identifyAuthor("web", "500", ["Dan"]);
  store.identifyAuthor("web", "300", ["Carol"]);
  await limits.record("100", 50, 0);
  await limits.record("200", 90, 0);
  await limits.record("500", 10, 0);
  await store.grantResets("global", "300", "week", 1);
  const ids = (page: { users: { user: string }[] }) => page.users.map(row => row.user);
  const all = await store.listKnownUsers("", 50, 0);
  // Bot 400 is not listed. Web-only 500 and 300 are listed, with no servers.
  assert.equal(all.total, 5);
  assert.deepEqual(ids(all), ["200", "100", "500", "700", "300"]);
  assert.deepEqual(all.users.find(row => row.user === "100"), { user: "100", names: ["Alice", "ali", "Alice A"], servers: ["s1", "s2"] });
  assert.deepEqual(all.users.find(row => row.user === "500"), { user: "500", names: ["Dan"], servers: [] });
  assert.deepEqual(all.users.find(row => row.user === "300"), { user: "300", names: ["Carol"], servers: [] });
  assert.deepEqual(ids(await store.listKnownUsers("  ALI ", 50, 0)), ["100"], "name search is case-insensitive and trimmed");
  assert.deepEqual(ids(await store.listKnownUsers("carol", 50, 0)), ["300"], "web names are searched");
  assert.deepEqual(ids(await store.listKnownUsers("100", 50, 0)), ["100"], "an exact ID matches that ID");
  assert.deepEqual(ids(await store.listKnownUsers(" 200 ", 50, 0)), ["200"]);
  assert.deepEqual(ids(await store.listKnownUsers("400", 50, 0)), [], "a bot is not a known user");
  assert.deepEqual(ids(await store.listKnownUsers("30", 50, 0)), [], "digits that are not an ID search the names");
  assert.deepEqual(ids(await store.listKnownUsers("zzz", 50, 0)), []);
  const page = await store.listKnownUsers("", 2, 0);
  assert.deepEqual([page.total, ids(page)], [5, ["200", "100"]]);
  assert.deepEqual(ids(await store.listKnownUsers("", 2, 2)), ["500", "700"]);
  assert.deepEqual(ids(await store.listKnownUsers("", 2, 4)), ["300"]);
  store.close();
});
