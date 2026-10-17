import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PostgresStore } from "../src/adapters/postgres.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { InboxItem, InboxStore } from "../src/inbox.js";

const server = "inbox-server", other = "inbox-other-server";
const member = "member-1", member2 = "member-2";

function item(id: string, patch: Partial<InboxItem> = {}): InboxItem {
  return { id, server, target: member, sender: "bot-a", channel: "chan-1", sourceIds: [`${id}-src-1`, `${id}-src-2`], summary: `summary ${id}`, created_at: 1000, done_at: null, ...patch };
}

test("markInboxDone only for target", async () => {
  const store = new SQLiteStore(":memory:");
  await store.addInboxItem(item("a", { target: member }));
  await store.addInboxItem(item("x", { target: member2 }));
  await store.addInboxItem(item("y", { target: member, server: other }));

  assert.equal(await store.markInboxDone(server, member, ["x"], 3000), 0, "an id of another target is not changed");
  assert.equal(await store.markInboxDone(other, member2, "all", 3000), 0, "another server is not changed");
  assert.equal(await store.markInboxDone(server, member, "all", 4000), 1, "all marks only open items of the target");
  assert.equal((await store.inboxItems(server, member2, { includeDone: false, limit: 10 })).length, 1);
  assert.equal((await store.inboxItems(other, member, { includeDone: false, limit: 10 })).length, 1);
  assert.equal(await store.markInboxDone(server, member, "all", 5000), 0, "done items keep their first done_at");
  assert.equal(await store.markInboxDone(server, member, [], 5000), 0);
  const done = await store.inboxItems(server, member, { includeDone: true, limit: 10 });
  assert.deepEqual(done.map(row => row.done_at), [4000]);
  store.close();
});

test("countInboxSent since", async () => {
  const store = new SQLiteStore(":memory:");
  await store.addInboxItem(item("a", { sender: "bot-a", created_at: 1000 }));
  await store.addInboxItem(item("b", { sender: "bot-a", created_at: 2000 }));
  await store.addInboxItem(item("c", { sender: "bot-a", created_at: 3000 }));
  await store.addInboxItem(item("d", { sender: "bot-b", created_at: 2500 }));
  await store.addInboxItem(item("e", { sender: "bot-a", created_at: 2500, server: other }));
  assert.equal(await store.markInboxDone(server, member, ["a"], 3500), 1);

  assert.equal(await store.countInboxSent(server, "bot-a", 2000), 2, "done items still count as sent");
  assert.equal(await store.countInboxSent(server, "bot-a", 0), 3);
  assert.equal(await store.countInboxSent(server, "bot-a", 3001), 0);
  assert.equal(await store.countInboxSent(server, "bot-b", 0), 1);
  assert.equal(await store.countInboxSent(other, "bot-a", 0), 1);
  store.close();
});

// Runs the same steps on any InboxStore and returns what each step gave, so SQLite and Postgres can be compared.
async function inboxSteps(store: InboxStore): Promise<Record<string, unknown>> {
  const log: Record<string, unknown> = {};
  await store.addInboxItem(item("a", { created_at: 1000, sourceIds: ["m1", "m2"] }));
  await store.addInboxItem(item("b", { created_at: 2000, sender: "bot-b" }));
  await store.addInboxItem(item("c", { created_at: 3000, target: member2 }));
  log.open = await store.inboxItems(server, member, { includeDone: false, limit: 10 });
  log.markedOne = await store.markInboxDone(server, member, ["a"], 4000);
  log.markedOther = await store.markInboxDone(server, member, ["c"], 4000);
  log.openAfter = await store.inboxItems(server, member, { includeDone: false, limit: 10 });
  log.all = await store.inboxItems(server, member, { includeDone: true, limit: 10 });
  log.sentSince = await store.countInboxSent(server, "bot-a", 500);
  log.deleted = await store.deleteExpiredInbox(2500);
  log.afterDelete = await store.inboxItems(server, member, { includeDone: true, limit: 10 });
  log.markedAll = await store.markInboxDone(server, member, "all", 5000);
  return log;
}

test("inbox items match SQLite on Postgres", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const url = process.env.TEST_DATABASE_URL!;
  const sqlite = new SQLiteStore(":memory:");
  const expected = await inboxSteps(sqlite);
  sqlite.close();

  const schema = `slopbot_inbox_${randomBytes(6).toString("hex")}`;
  const postgres = await PostgresStore.connect(url, undefined, schema);
  try {
    assert.deepEqual(await inboxSteps(postgres), expected);
  } finally {
    await postgres.close();
    const cleanup = new Client({ connectionString: url });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  }
});
test("deleteExpiredInbox", async () => {
  const store = new SQLiteStore(":memory:");
  await store.addInboxItem(item("a", { created_at: 1000 }));
  await store.addInboxItem(item("b", { created_at: 2000, done_at: 2100 }));
  await store.addInboxItem(item("c", { created_at: 3000 }));

  assert.equal(await store.deleteExpiredInbox(2500), 2, "open and done rows older than the cutoff are deleted");
  assert.deepEqual((await store.inboxItems(server, member, { includeDone: true, limit: 10 })).map(row => row.id), ["c"]);
  assert.equal(await store.deleteExpiredInbox(2500), 0);
  store.close();
});

