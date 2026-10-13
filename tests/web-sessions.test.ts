import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { createConsole, type ConsoleOptions } from '../src/web-console.js';

const DAY = 86_400_000;
const options: ConsoleOptions = { origin: 'http://localhost:3000', host: '127.0.0.1', port: 0, clientId: 'id', clientSecret: 'secret' };
const user = '123456789012345678';
type Row = { id_hash: string; user_id: string; csrf: string; expires: number; created: number };

function databaseFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'slopbot-sessions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'slopbot.db');
}
// Starts a console with a fake Discord login. The store is the only session state.
async function start(t: TestContext, store: SQLiteStore): Promise<{ base: string; server: Server }> {
  const server = createConsole(options, { sessions: store, async canSignIn() { return true; }, async snapshot(id) { return { user: id }; }, async invoke() { return {}; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://discord.com/api/oauth2/token') return Response.json({ access_token: 'oauth-secret' });
    if (String(url) === 'https://discord.com/api/users/@me') return Response.json({ id: user });
    return originalFetch(url, init);
  });
  return { base: `http://127.0.0.1:${address.port}`, server };
}
// Signs in through the callback and returns the raw session cookie value.
async function login(base: string): Promise<string> {
  const first = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const state = new URL(first.headers.get('location')!).searchParams.get('state')!;
  const callback = await fetch(`${base}/auth/callback?state=${state}&code=x`, { redirect: 'manual', headers: { Cookie: `slopbot_state=${state}` } });
  assert.equal(callback.status, 302);
  return callback.headers.getSetCookie()[0]!.split(';')[0]!.slice('slopbot_session='.length);
}
const settings = (base: string, cookie: string) => fetch(`${base}/api/settings`, { headers: { Cookie: `slopbot_session=${cookie}` } });
// Reads and changes the table directly, the way a second process would.
function rows(file: string): Row[] {
  const db = new DatabaseSync(file);
  try { return db.prepare('SELECT id_hash,user_id,csrf,expires,created FROM web_sessions').all() as unknown as Row[]; }
  finally { db.close(); }
}
function setExpires(file: string, expires: number): void {
  const db = new DatabaseSync(file);
  try { db.prepare('UPDATE web_sessions SET expires=?').run(expires); }
  finally { db.close(); }
}

test('login survives a restart with the same database', async t => {
  const file = databaseFile(t);
  const first = new SQLiteStore(file);
  const before = await start(t, first);
  const cookie = await login(before.base);
  const csrf = (await (await settings(before.base, cookie)).json() as { csrf: string }).csrf;
  await new Promise<void>(resolve => before.server.close(() => resolve()));
  first.close();
  const second = new SQLiteStore(file);
  t.after(() => second.close());
  const after = await start(t, second);
  const response = await settings(after.base, cookie);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { csrf: string }).csrf, csrf);
});
test('expired login is refused and its row is deleted', async t => {
  const file = databaseFile(t);
  const store = new SQLiteStore(file);
  t.after(() => store.close());
  const { base } = await start(t, store);
  const cookie = await login(base);
  setExpires(file, Date.now() - 1);
  assert.equal((await settings(base, cookie)).status, 401);
  assert.equal(rows(file).length, 0);
});
test('expired rows are removed by the periodic cleanup', async t => {
  const file = databaseFile(t);
  const store = new SQLiteStore(file);
  t.after(() => store.close());
  const { base } = await start(t, store);
  await login(base);
  setExpires(file, Date.now() - 1);
  assert.equal(await store.deleteExpiredSessions(Date.now()), 1);
  assert.equal(rows(file).length, 0);
});
test('logout removes the session row and refuses the cookie', async t => {
  const file = databaseFile(t);
  const store = new SQLiteStore(file);
  t.after(() => store.close());
  const { base } = await start(t, store);
  const cookie = await login(base);
  const csrf = (await (await settings(base, cookie)).json() as { csrf: string }).csrf;
  const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: `slopbot_session=${cookie}`, Origin: 'http://localhost:3000', 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.equal(rows(file).length, 0);
  assert.equal((await settings(base, cookie)).status, 401);
});
test('the database holds a hash of the session id, not the cookie value', async t => {
  const file = databaseFile(t);
  const store = new SQLiteStore(file);
  t.after(() => store.close());
  const { base } = await start(t, store);
  const cookie = await login(base);
  const csrf = (await (await settings(base, cookie)).json() as { csrf: string }).csrf;
  const [row] = rows(file);
  assert.equal(row!.id_hash, createHash('sha256').update(cookie).digest('hex'));
  assert.equal(row!.user_id, user);
  assert.equal(row!.csrf, csrf);
  assert.equal(readFileSync(file).includes(Buffer.from(cookie)), false);
});
test('a login with under 29 days left is extended and its cookie is sent again', async t => {
  const file = databaseFile(t);
  const store = new SQLiteStore(file);
  t.after(() => store.close());
  const { base } = await start(t, store);
  const cookie = await login(base);
  setExpires(file, Date.now() + 10 * DAY);
  const renewed = await settings(base, cookie);
  assert.equal(renewed.status, 200);
  const setCookie = renewed.headers.get('set-cookie')!;
  assert.match(setCookie, new RegExp(`^slopbot_session=${cookie}; `));
  assert.match(setCookie, /Max-Age=2592000/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /Secure/);
  const extended = rows(file)[0]!.expires;
  assert.ok(extended <= Date.now() + 30 * DAY && extended >= Date.now() + 30 * DAY - 60_000);
  // A login with more than 29 days left keeps its expiry and gets no new cookie.
  const kept = Date.now() + 31 * DAY;
  setExpires(file, kept);
  const fresh = await settings(base, cookie);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('set-cookie'), null);
  assert.equal(rows(file)[0]!.expires, kept);
});
