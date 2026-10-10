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
  assert.equal(importer.state("c").job?.before, "151");
  await importer.pause("c");
  const resumed = new HistoryImporter("s", store, healthy, 7, () => now);
  await resumed.start("c"); await resumed.idle();
  assert.equal(store.indexStats("s", "c").messages, 100);
  await resumed.resume("c"); await resumed.idle();
  assert.equal(store.indexStats("s", "c").messages, 250);
  assert.equal(resumed.state("c").job, null);
});

test("embedding usage counts actual reported tokens and missing counts; duplicate queues reuse vectors", async t => {
  let calls = 0;
  const store = new SQLiteStore(":memory:", { model: "test", async embed() { return [1, 0]; }, async embedWithUsage() {
    return { vector: [1, 0], tokens: ++calls === 1 ? 12 : null };
  } });
  t.after(() => store.close());
  const rows = messages(2);
  for (const row of rows) await store.ingest(row);
  store.reindex("s", ["c"]);
  await store.finishIndexing();
  assert.equal(calls, 2);
  assert.equal(store.indexStats("s", "c").vectors, 2);
  assert.deepEqual(store.indexStats("s", "c").usage, [{ model: "test", purpose: "index", requests: 2, tokens: 12, unknown: 1 }]);
});
