import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { UserLimiter } from "../src/user-limiter.js";
import { UsageMeter } from "../src/usage-meter.js";
import { DEFAULT_FALLBACK_PRICE, type PriceTable } from "../src/usage-cost.js";
import { privateChannel } from "../src/private-chat.js";
import type { Message } from "../src/domain.js";

const server = "s";
const alice = "alice";
const discord = "100000000000000001";
const ownerChat = privateChannel("0123456789abcdef0123456789abcdef");

// Micro-dollars per million tokens: 2 micros per input token, 0.5 per cached token, 4 per output token.
const prices: PriceTable = { nimbus: { input: 2000000, cached_input: 500000, output: 4000000 }, vane: { input: 1000000, cached_input: 1000000, output: 1000000 } };
const usage = (prompt: number, cached: number, completion: number) => ({ prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached } });

function meterFor(store: SQLiteStore, totals: Pick<SQLiteStore, "addTokenTotals"> | undefined = store): UsageMeter {
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 0, weekCostMicros: 0, gracePercent: 10 });
  return new UsageMeter(limiter, () => prices, DEFAULT_FALLBACK_PRICE, totals);
}

function webMessage(id: string): Message {
  return { id, server, channel: ownerChat, author: alice, authorName: "Alice", text: "secret plan", timestamp: 1 } as Message;
}

test("a charged call adds its tokens and cost to the lifetime totals", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const before = Date.now();
  await meterFor(store).record({ server, user: alice }, "nimbus", usage(1000, 400, 100));
  const after = Date.now();
  const [row] = await store.userTokenTotals(server, alice);
  assert.equal(row?.model, "nimbus");
  assert.equal(row?.requests, 1);
  assert.equal(row?.input, 600, "input is the uncached prompt");
  assert.equal(row?.cached, 400);
  assert.equal(row?.output, 100);
  assert.equal(row?.costMicros, 1800, "the same cost the limiter charges");
  assert.ok(row!.firstAt >= before && row!.firstAt <= after);
  assert.equal(row?.lastAt, row?.firstAt);
});

test("two calls by the same user and model sum into one row", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const meter = meterFor(store);
  await meter.record({ server, user: alice }, "nimbus", usage(1000, 400, 100));
  const [first] = await store.userTokenTotals(server, alice);
  await meter.record({ server, user: alice }, "nimbus", usage(500, 0, 50));
  const rows = await store.userTokenTotals(server, alice);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.requests, 2);
  assert.equal(rows[0]?.input, 1100);
  assert.equal(rows[0]?.cached, 400);
  assert.equal(rows[0]?.output, 150);
  assert.equal(rows[0]?.costMicros, 1800 + 1200);
  assert.equal(rows[0]?.firstAt, first?.firstAt, "first_at never moves");
  assert.ok(rows[0]!.lastAt >= rows[0]!.firstAt);
});

test("different models are separate rows, and other users are not mixed in", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const meter = meterFor(store);
  await meter.record({ server, user: alice }, "nimbus", usage(1000, 0, 0));
  await meter.record({ server, user: alice }, "vane", usage(10, 0, 0));
  await meter.record({ server, user: "bob" }, "nimbus", usage(1, 0, 0));
  const rows = await store.userTokenTotals(server, alice);
  assert.deepEqual(rows.map(row => [row.model, row.requests, row.input]), [["nimbus", 1, 1000], ["vane", 1, 10]]);
  assert.deepEqual((await store.userTokenTotals(server, "bob")).map(row => row.model), ["nimbus"]);
});

test("nothing is counted without a payer, such as an admin reindex", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await meterFor(store).record(undefined, "nimbus", usage(1000, 0, 100));
  assert.deepEqual(await store.userTokenTotals(server, alice), []);
});

test("deleting a private chat and purging channels never reduce the totals", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.insertWebChat({ id: "0123456789abcdef0123456789abcdef", server, owner: alice, title: "", created: 1, updated: 1, deleted: false });
  await store.ingest(webMessage("web-secret"));
  await meterFor(store).record({ server, user: alice }, "nimbus", usage(1000, 400, 100));
  const counted = await store.userTokenTotals(server, alice);
  await store.deleteWebChat("0123456789abcdef0123456789abcdef", server, ownerChat, 2);
  await store.purgeUnconfigured(server, []);
  await store.purgeChannelBefore(server, discord, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(await store.userTokenTotals(server, alice), counted);
});

test("a recording error is logged and never thrown to the caller", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const logged: unknown[] = [];
  t.mock.method(console, "error", (line: string) => { logged.push(line); });
  const failing = { addTokenTotals: async () => { throw new Error("disk full"); } };
  await meterFor(store, failing).record({ server, user: alice }, "nimbus", usage(1000, 0, 100));
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]), /token_totals_record_failed/);
  // The charge itself still happened.
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 0, weekCostMicros: 0, gracePercent: 10 });
  assert.equal((await limiter.usage(alice))[0]?.spent, 2000 + 400);
});

test("the totals table is created in both schemas and no delete path touches it", () => {
  const read = (path: string) => readFileSync(new URL(`../../src/adapters/${path}`, import.meta.url), "utf8");
  const sqlite = read("sqlite.ts"), postgres = read("postgres.ts"), schema = read("postgres-schema.sql");
  assert.match(sqlite, /CREATE TABLE IF NOT EXISTS user_token_totals \(server TEXT NOT NULL, user_id TEXT NOT NULL, model TEXT NOT NULL, requests BIGINT NOT NULL, input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL, cached_tokens BIGINT NOT NULL, cost_micros BIGINT NOT NULL, first_at BIGINT NOT NULL, last_at BIGINT NOT NULL, PRIMARY KEY\(server,user_id,model\)\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS user_token_totals \(server TEXT NOT NULL, user_id TEXT NOT NULL, model TEXT NOT NULL, requests BIGINT NOT NULL, input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL, cached_tokens BIGINT NOT NULL, cost_micros BIGINT NOT NULL, first_at BIGINT NOT NULL, last_at BIGINT NOT NULL, PRIMARY KEY\(server,user_id,model\)\)/);
  assert.match(postgres, /ON CONFLICT\(server,user_id,model\) DO UPDATE SET requests=user_token_totals\.requests\+1/, "Postgres upsert adds to the totals");
  assert.doesNotMatch(sqlite + postgres, /DELETE FROM user_token_totals/, "no store path deletes the totals");
});
