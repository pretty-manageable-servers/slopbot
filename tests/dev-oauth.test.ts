import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { consoleOptions, createConsole } from '../src/web-console.js';

const ALICE = '100000000000000005', OUTSIDER = '100000000000000009';
const script = fileURLToPath(new URL('../../scripts/development/dev-oauth.mjs', import.meta.url));
const webEnv = { WEB_ENABLED: 'true', DISCORD_CLIENT_ID: 'id', DISCORD_CLIENT_SECRET: 'secret' };

/** Starts scripts/development/dev-oauth.mjs on a free port and returns its base URL once it is listening. */
async function startDevOauth(t: TestContext) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [script], { env: { ...process.env, DEV_OAUTH_PORT: String(port), DEV_OAUTH_USER: '', DEV_OAUTH_AUTO: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { child.kill('SIGTERM'); });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', code => reject(new Error(`dev-oauth exited with ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

/** Starts a console that signs in through oauthBase. Only ALICE is a member of a server Slopbot is in. */
async function startConsole(t: TestContext, oauthBase: string) {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const server = createConsole({ origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, clientId: 'id', clientSecret: 'secret', oauthBase, llmStatus: user => ({ mode: 'fallback', canChat: user === ALICE }) }, {
    sessions: store, async canSignIn(user) { return user === ALICE; }, async snapshot() { return {}; }, async invoke() { return {}; },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/** Runs the sign-in flow the way a browser does: /auth/login, the dev sign-in form, then the console callback. Returns the callback response. */
async function signIn(base: string, oauthBase: string, user: string) {
  const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location')!);
  assert.equal((await fetch(authorize)).status, 200);
  const state = authorize.searchParams.get('state')!;
  const submitted = await fetch(`${oauthBase}/oauth2/authorize`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ user, redirect_uri: authorize.searchParams.get('redirect_uri')!, state }) });
  const callback = new URL(submitted.headers.get('location')!);
  return fetch(`${base}${callback.pathname}${callback.search}`, { redirect: 'manual', headers: { Cookie: `slopbot_state=${state}` } });
}

test('dev OAuth sign-in ends with a session for the chosen user', async t => {
  const oauthBase = await startDevOauth(t);
  const base = await startConsole(t, oauthBase);
  const done = await signIn(base, oauthBase, ALICE);
  assert.equal(done.status, 302);
  const session = done.headers.getSetCookie()[0]!.split(';')[0]!;
  const status = await fetch(`${base}/api/status`, { headers: { Cookie: session } });
  assert.deepEqual(await status.json(), { mode: 'fallback', canChat: true });
});

test('dev OAuth sign-in still needs the bot to find the user in a server', async t => {
  const oauthBase = await startDevOauth(t);
  const base = await startConsole(t, oauthBase);
  for (const [user, status] of [[ALICE, 302], [OUTSIDER, 403]] as const) {
    const res = await signIn(base, oauthBase, user);
    assert.equal(res.status, status);
    assert.equal(res.headers.getSetCookie().some(cookie => cookie.startsWith('slopbot_session=')), status === 302);
  }
});

test('dev OAuth refuses a bad user id or a redirect that is not localhost', async t => {
  const oauthBase = await startDevOauth(t);
  const valid = { user: ALICE, redirect_uri: 'http://localhost:3000/auth/callback', state: 'abc' };
  for (const change of [{ user: 'alice' }, { user: '1234' }, { redirect_uri: 'https://evil.example/callback' }, { redirect_uri: 'http://localhost.evil.example/callback' }]) {
    const res = await fetch(`${oauthBase}/oauth2/authorize`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...valid, ...change }) });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
  }
});

test('consoleOptions refuses the dev OAuth base in production', () => {
  assert.throws(() => consoleOptions({ ...webEnv, WEB_OAUTH_BASE: 'http://127.0.0.1:9091', NODE_ENV: 'production' }), /WEB_OAUTH_BASE is for local development only/);
});

test('consoleOptions refuses a dev OAuth base that is not local', () => {
  for (const extra of [
    { WEB_OAUTH_BASE: 'https://discord.example.com' },
    { WEB_OAUTH_BASE: 'http://192.168.1.10:9091' },
    { WEB_OAUTH_BASE: 'ftp://127.0.0.1:9091' },
    { WEB_OAUTH_BASE: 'http://127.0.0.1:9091', WEB_ORIGIN: 'https://slop.example.com' },
  ]) assert.throws(() => consoleOptions({ ...webEnv, ...extra }), /WEB_OAUTH_BASE/);
});

test('consoleOptions keeps the dev OAuth base as an origin', () => {
  assert.equal(consoleOptions({ ...webEnv, WEB_OAUTH_BASE: 'http://127.0.0.1:9091/' })?.oauthBase, 'http://127.0.0.1:9091');
  assert.equal(consoleOptions(webEnv)?.oauthBase, undefined);
});
