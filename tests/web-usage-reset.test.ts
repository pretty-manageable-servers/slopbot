import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { createConsole } from "../src/web-console.js";
import { ToolError } from "../src/tools.js";

const SERVER = "1528063444874432734", ALICE = "1514413259522838529", ORIGIN = "http://localhost:3000";

test("a member uses their own banked reset from the web, and gets the new meter", async t => {
  const store = new SQLiteStore(":memory:"); t.after(() => store.close());
  const id = randomBytes(32).toString("hex");
  await store.saveSession({ id_hash: createHash("sha256").update(id).digest("hex"), user_id: ALICE, csrf: "c", expires: Date.now() + 86_400_000, created: Date.now() });
  let banked = 1;
  const calls: string[] = [];
  const web = createConsole({ origin: ORIGIN, host: "127.0.0.1", port: 3000, clientId: "id", clientSecret: "secret" }, {
    sessions: store, async canSignIn() { return true; }, async snapshot() { return {}; }, async invoke() { return {}; },
    async useReset(user, server, kind) {
      calls.push(`${user} ${server} ${kind}`);
      if (!banked) throw new ToolError("You have no banked 5-hour reset.");
      banked--;
      return { plan: "free", windows: [{ kind, percent: 0, resetAt: null, banked }] };
    },
  });
  web.listen(0, "127.0.0.1"); await once(web, "listening");
  t.after(() => new Promise<void>(resolve => { web.closeAllConnections(); web.close(() => resolve()); }));
  const address = web.address(); if (!address || typeof address === "string") throw new Error("no address");
  const post = (body: unknown, csrf = "c") => fetch(`http://127.0.0.1:${address.port}/api/usage/reset`, { method: "POST", headers: { Cookie: `slopbot_session=${id}`, Origin: ORIGIN, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const ok = await post({ server: SERVER, kind: "5h" });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).windows[0], { kind: "5h", percent: 0, resetAt: null, banked: 0 });
  assert.deepEqual(calls, [`${ALICE} ${SERVER} 5h`], "the session user is used, never one from the body");
  const none = await post({ server: SERVER, kind: "5h" });
  assert.equal(none.status, 409);
  assert.match((await none.json()).error, /no banked/);
  assert.equal((await post({ server: SERVER, kind: "day" })).status, 400);
  assert.equal((await post({ server: "x", kind: "5h" })).status, 400);
  assert.equal((await post({ server: SERVER, kind: "5h" }, "wrong")).status, 403);
  assert.equal(calls.length, 2);
});
