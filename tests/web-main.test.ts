import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startLocalConsole } from '../src/web-main.js';
import { LOCAL_ONLY } from '../src/local/world.js';

const script = fileURLToPath(new URL('../../scripts/development/dev-oauth.mjs', import.meta.url));
const world = fileURLToPath(new URL('../../dev/local-world.json', import.meta.url));
const SERVER = '100000000000000001', MEMBER = '200000000000000002', OUTSIDER = '200000000000000003';

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function startDevOauth(t: TestContext) {
  const port = await freePort();
  const child = spawn(process.execPath, [script], { env: { ...process.env, DEV_OAUTH_PORT: String(port), DEV_OAUTH_USER: '', DEV_OAUTH_AUTO: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { child.kill('SIGTERM'); });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', code => reject(new Error(`dev-oauth exited with ${code}`)));
  });
  child.stdout!.resume();
  return `http://127.0.0.1:${port}`;
}

/** The sign-in flow of a browser. Returns the Cookie header, or undefined when sign-in is refused. */
async function signIn(base: string, oauthBase: string, user: string) {
  const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location')!);
  const state = authorize.searchParams.get('state')!;
  const submitted = await fetch(`${oauthBase}/oauth2/authorize`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ user, redirect_uri: authorize.searchParams.get('redirect_uri')!, state }) });
  const callback = new URL(submitted.headers.get('location')!);
  const done = await fetch(`${base}${callback.pathname}${callback.search}`, { redirect: 'manual', headers: { Cookie: `slopbot_state=${state}` } });
  const session = done.headers.getSetCookie().map(cookie => cookie.split(';')[0]!).find(cookie => cookie.startsWith('slopbot_session='));
  return { status: done.status, cookie: session };
}

test('the local console signs in and chats with no Discord', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'web-main-'));
  const oauthBase = await startDevOauth(t);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const local = await startLocalConsole({
    SLOPBOT_PLATFORM: 'local', LLM_MODE: 'mock', WEB_ENABLED: 'true', WEB_PORT: String(port), WEB_ORIGIN: base, WEB_OAUTH_BASE: oauthBase,
    LOCAL_WORLD: world, DATABASE_PATH: join(dir, 's.sqlite3'),
  });
  t.after(async () => { await local.stop(); rmSync(dir, { recursive: true, force: true }); });

  const outsider = await signIn(base, oauthBase, OUTSIDER);
  assert.equal(outsider.status, 403);
  assert.equal(outsider.cookie, undefined);

  const member = await signIn(base, oauthBase, MEMBER);
  assert.equal(member.status, 302);
  const cookie = member.cookie!;
  const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json() as { servers: { id: string }[]; csrf: string };
  assert.deepEqual(session.servers.map(server => server.id), [SERVER]);

  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created = await post('/api/chats', { server: SERVER });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  assert.equal((await post(`/api/chats/${id}/messages`, { text: 'hi' })).status, 201);

  let reply: { text: string } | undefined;
  for (let attempt = 0; attempt < 100 && !reply; attempt++) {
    const { messages } = await (await fetch(`${base}/api/chats/${id}/messages`, { headers: { Cookie: cookie } })).json() as { messages: { slopbot: boolean; text: string }[] };
    reply = messages.find(message => message.slopbot || message.text.startsWith('Local reply'));
    if (!reply) await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(reply, 'the bot answered in the chat');

  const invoke = await post('/api/settings', { server: SERVER, channel: '1', name: 'profile', args: { action: 'set' } });
  assert.match(JSON.stringify(await invoke.json()), new RegExp(LOCAL_ONLY.replace(/\./g, '\\.')));
});
