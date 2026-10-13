import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryImporter, type HistorySource } from "../src/history.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Message } from "../src/domain.js";

const day = 86400000;
const now = 100 * day;
function messages(count: number, step = day): Message[] {
  return Array.from({ length: count }, (_, i) => ({ id: String(count - i), server: "s", channel: "c", author: "a", text: `message ${i}`, timestamp: now - i * step }));
}
function source(rows: Message[]): HistorySource {
  return { async fetch(_channel, before, limit) {
    const start = before === null ? 0 : rows.findIndex(message => message.id === before) + 1;
    return rows.slice(start, start + limit);
  } };
}

test("window fills recent text, more extends older coverage, then catch-up fills offline gaps", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const rows = messages(20);
  let clock = now;
  const importer = new HistoryImporter("s", store, source(rows), 7, () => clock);
  await importer.start("c"); await importer.idle();
  assert.equal(store.indexStats("s", "c").messages, 8);
  assert.equal(importer.state("c").oldest?.id, "13");
  await importer.start("c", "more"); await importer.idle();
  assert.equal(store.indexStats("s", "c").messages, 20);
  assert.equal(importer.state("c").exhausted, true);
  clock += 20 * day;
  rows.unshift({ ...rows[0]!, id: "21", timestamp: now + day }, { ...rows[0]!, id: "22", timestamp: clock });
  rows.sort((a, b) => b.timestamp! - a.timestamp!);
  await importer.start("c"); await importer.idle();
  assert.equal(store.indexStats("s", "c").messages, 22);
  assert.equal(importer.state("c").oldest?.id, "1");
});

test("older imports advance in 5000-message batches and reuse existing source records", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const importer = new HistoryImporter("s", store, source(messages(5100, 1)), 7, () => now);
  await importer.start("c", "more"); await importer.idle();
  assert.equal(store.indexStats("s", "c").messages, 5000);
  assert.equal(importer.state("c").exhausted, false);
  await importer.start("c", "more"); await importer.idle();
  assert.equal(store.indexStats("s", "c").messages, 5100);
  assert.equal(importer.state("c").exhausted, true);
  await importer.start("c", "window"); await importer.idle();
  assert.equal(store.indexStats("s", "c").messages, 5100);
});

test("failed imports retain a cursor, pause blocks work, and a new worker resumes", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const rows = messages(250, 1), healthy = source(rows);
  let calls = 0;
  const importer = new HistoryImporter("s", store, { async fetch(...args) {
    if (++calls === 2) throw new Error("offline");
    return healthy.fetch(...args);
  } }, 7, () => now);
  await importer.start("c"); await importer.idle();
  assert.equal(store.indexStats("s", "c").messages, 100);
  assert.equal(importer.state("c").error, true);
  assert.match(importer.state("c").errorReason ?? "", /UNEXPECTED_ERROR/);
  assert.equal(importer.state("c").job?.before, "151");
  // The first page reached the 100th newest message, so the job's oldest reached time is that message's time.
  assert.equal(importer.state("c").job?.reachedAt, now - 99);
  await importer.pause("c");
  const resumed = new HistoryImporter("s", store, healthy, 7, () => now);
  await resumed.start("c"); await resumed.idle();
  assert.equal(store.indexStats("s", "c").messages, 100);
  await resumed.resume("c"); await resumed.idle();
  assert.equal(store.indexStats("s", "c").messages, 250);
  assert.equal(resumed.state("c").job, null);
});

test("only saved memories generate embedding usage; backfill reuses vectors", async t => {
  let calls = 0;
  const store = new SQLiteStore(":memory:", { model: "test", async embed() { return [1, 0]; }, async embedWithUsage() {
    return { vector: [1, 0], tokens: ++calls === 1 ? 12 : null };
  } });
  t.after(() => store.close());
  const rows = messages(2);
  for (const row of rows) await store.ingest(row);
  assert.equal(store.reindex("s", ["c"]), 0);
  await store.finishIndexing();
  assert.equal(calls, 0);
  for (const row of rows) await store.remember(row, row.text);
  store.reindex("s", ["c"]);
  await store.finishIndexing();
  assert.equal(calls, 2);
  assert.equal(store.indexStats("s", "c").vectors, 2);
  assert.deepEqual(store.indexStats("s", "c").usage, [{ model: "test", purpose: "memory_index", requests: 2, tokens: 12, unknown: 1 }]);
});

test("lowering the window deletes only older messages of that channel and server; raising deletes nothing", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const rows = messages(20);
  const importer = new HistoryImporter("s", store, source(rows), 30, () => now);
  await importer.start("c"); await importer.idle();
  assert.equal(store.indexStats("s", "c").messages, 20);
  const other = (id: string, server: string, channel: string) => ({ id, server, channel, author: "a", text: id, timestamp: now - 19 * day });
  await store.ingest(other("x1", "s", "d"));
  await store.ingest(other("x2", "t", "c"));

  await importer.start("c", "window", 40); await importer.idle();
  assert.equal(store.indexStats("s", "c").messages, 20);
  assert.equal(importer.state("c").days, 40);

  // Keeps the messages from the last 5 days, so ids 15 to 20 remain and 14 are deleted.
  await importer.start("c", "window", 5); await importer.idle();
  assert.equal(importer.state("c").days, 5);
  assert.equal(store.indexStats("s", "c").messages, 6);
  assert.equal(importer.state("c").oldest?.id, "15");
  assert.equal(store.indexStats("s", "d").messages, 1);
  assert.equal(store.indexStats("t", "c").messages, 1);
});
