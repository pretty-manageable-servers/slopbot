import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PostgresStore } from "../src/adapters/postgres.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { hasUserInstructions, type UserInstructionsStore } from "../src/user-instructions.js";

interface OpenedStore { store: UserInstructionsStore; close(): Promise<void> }

// Epoch milliseconds, above the 32-bit range, so the stored time must keep its full size.
const NOV_6 = Date.UTC(2026, 10, 6, 9);

async function openSqlite(): Promise<OpenedStore> {
  const store = new SQLiteStore();
  return { store, close: async () => store.close() };
}

async function openPostgres(): Promise<OpenedStore> {
  const url = process.env.TEST_DATABASE_URL!;
  const schema = `slopbot_instructions_${randomBytes(6).toString("hex")}`;
  const store = await PostgresStore.connect(url, undefined, schema);
  return {
    store,
    close: async () => {
      await store.close();
      const cleanup = new Client({ connectionString: url });
      await cleanup.connect();
      try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await cleanup.end(); }
    },
  };
}

function instructionCases(backend: string, open: () => Promise<OpenedStore>, skip: boolean) {
  test(`${backend}: a user with no saved instructions reads as undefined`, { skip }, async t => {
    const { store, close } = await open(); t.after(close);
    assert.equal(await store.userInstructions("alice"), undefined);
  });

  test(`${backend}: the saved text and time are read back`, { skip }, async t => {
    const { store, close } = await open(); t.after(close);
    await store.setUserInstructions("alice", "Answer briefly.", NOV_6);
    assert.deepEqual(await store.userInstructions("alice"), { text: "Answer briefly.", updated: NOV_6 });
    assert.equal(await store.userInstructions("bob"), undefined, "another user's instructions are not affected");
  });

  test(`${backend}: saving again replaces the text and the time`, { skip }, async t => {
    const { store, close } = await open(); t.after(close);
    await store.setUserInstructions("alice", "Answer briefly.", NOV_6);
    await store.setUserInstructions("alice", "Answer in French.", NOV_6 + 60_000);
    assert.deepEqual(await store.userInstructions("alice"), { text: "Answer in French.", updated: NOV_6 + 60_000 });
  });

  test(`${backend}: deleted instructions read as undefined`, { skip }, async t => {
    const { store, close } = await open(); t.after(close);
    await store.setUserInstructions("alice", "Answer briefly.", NOV_6);
    await store.deleteUserInstructions("alice");
    assert.equal(await store.userInstructions("alice"), undefined);
  });

  test(`${backend}: deleting a user with no saved instructions does not fail`, { skip }, async t => {
    const { store, close } = await open(); t.after(close);
    await assert.doesNotReject(store.deleteUserInstructions("nobody"));
  });

  test(`${backend}: the store passes the hasUserInstructions check`, { skip }, async t => {
    const { store, close } = await open(); t.after(close);
    assert.ok(hasUserInstructions(store));
  });
}

instructionCases("SQLite", openSqlite, false);
instructionCases("Postgres", openPostgres, !process.env.TEST_DATABASE_URL);
