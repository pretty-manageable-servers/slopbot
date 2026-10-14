import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { createConsole, type ConsoleBackend } from "../src/web-console.js";
import type { InboxItem } from "../src/inbox.js";

const SERVER = "1528063444874432734", ALICE = "1514413259522838529", ORIGIN = "http://localhost:3000";

const item: InboxItem = {
  id: "item-1", server: SERVER, target: ALICE, sender: "1514413259522838530", channel: "1528063444874432800",
  sourceIds: ["1528063444874432900"], summary: "Bob asked for the deploy notes.", created_at: 1_000, done_at: null,
};

/** Starts a console with one signed-in user (Alice) and the given backend extras. */
async function start(t: { after(fn: () => unknown): void }, inbox?: NonNullable<ConsoleBackend["inbox"]>) {
  const store = new SQLiteStore(":memory:"); t.after(() => store.close());
  const id = randomBytes(32).toString("hex");
  await store.saveSession({ id_hash: createHash("sha256").update(id).digest("hex"), user_id: ALICE, csrf: "c", expires: Date.now() + 86_400_000, created: Date.now() });
  const web = createConsole({ origin: ORIGIN, host: "127.0.0.1", port: 3000, clientId: "id", clientSecret: "secret" }, {
    sessions: store, async canSignIn() { return true; }, async snapshot() { return {}; }, async invoke() { return {}; }, ...(inbox ? { inbox } : {}),
  });
  web.listen(0, "127.0.0.1"); await once(web, "listening");
  t.after(() => new Promise<void>(resolve => { web.closeAllConnections(); web.close(() => resolve()); }));
  const address = web.address(); if (!address || typeof address === "string") throw new Error("no address");
  const base = `http://127.0.0.1:${address.port}/api/servers/${SERVER}/inbox`;
  const headers = { Cookie: `slopbot_session=${id}`, Origin: ORIGIN, "X-CSRF-Token": "c", "Content-Type": "application/json" };
  return {
    get: (query = "") => fetch(`${base}${query}`, { headers: { Cookie: `slopbot_session=${id}` } }),
    done: (body: unknown, csrf = "c") => fetch(`${base}/done`, { method: "POST", headers: { ...headers, "X-CSRF-Token": csrf }, body: JSON.stringify(body) }),
  };
}

test("inbox route lists items", async t => {
  const calls: string[] = [];
  const app = await start(t, {
    async list(user, server, includeDone) { calls.push(`${user} ${server} ${includeDone}`); return [item]; },
    async done() { return 0; },
  });
  const open = await app.get();
  assert.equal(open.status, 200);
  assert.deepEqual(await open.json(), { items: [item] });
  const all = await app.get("?done=1");
  assert.equal(all.status, 200);
  assert.deepEqual((await all.json()).items, [item]);
  assert.deepEqual(calls, [`${ALICE} ${SERVER} false`, `${ALICE} ${SERVER} true`], "the session user is used and done=1 includes done items");
});

test("inbox done route validates ids", async t => {
  const calls: unknown[] = [];
  const app = await start(t, {
    async list() { return []; },
    async done(user, server, ids) { calls.push([user, server, ids]); return Array.isArray(ids) ? ids.length : 0; },
  });
  const bad = [{}, { ids: "some" }, { ids: [] }, { ids: Array.from({ length: 101 }, (_v, i) => `${i}`) }, { ids: ["1", 2] }, { ids: null }];
  for (const body of bad) assert.equal((await app.done(body)).status, 400, JSON.stringify(body));
  const ok = await app.done({ ids: ["1528063444874432900"] });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { changed: 1 });
  const max = await app.done({ ids: Array.from({ length: 100 }, (_v, i) => `${i}`) });
  assert.equal(max.status, 200);
  assert.deepEqual(await max.json(), { changed: 100 });
  assert.equal(calls.length, 2, "only valid bodies reach the backend");
  assert.deepEqual(calls[0], [ALICE, SERVER, ["1528063444874432900"]]);
  assert.equal((await app.done({ ids: ["1"] }, "wrong")).status, 403);
  assert.equal(calls.length, 2);
});

test("inbox done all", async t => {
  const calls: unknown[] = [];
  const app = await start(t, {
    async list() { return []; },
    async done(user, server, ids) { calls.push([user, server, ids]); return 3; },
  });
  const res = await app.done({ ids: "all" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { changed: 3 });
  assert.deepEqual(calls, [[ALICE, SERVER, "all"]]);
});

test("inbox route 404 without backend", async t => {
  const app = await start(t, undefined);
  assert.equal((await app.get()).status, 404);
  assert.equal((await app.done({ ids: "all" })).status, 404);
});
