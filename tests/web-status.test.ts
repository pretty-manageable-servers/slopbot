import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { SQLiteStore } from '../src/adapters/sqlite.js';
import { AdminPanel, type AdminConfig } from '../src/admin-panel.js';
import { createConsole, type ConsoleAdmin, type ConsoleOptions } from '../src/web-console.js';
import { TeamAdmins, type TeamSnapshot } from '../src/team-admins.js';
import { UserLimiter } from '../src/user-limiter.js';
import { MemberDirectory } from '../src/member-directory.js';
import { SERVER_NON_ZDR_SETTING, USER_NON_ZDR_SETTING } from '../src/llm-mode.js';
import { GLOBAL_SETTINGS_SCOPE } from '../src/usage-cost.js';
import { fakeSource } from './member-fakes.js';

const OWNER = '100000000000000001', DEVELOPER = '100000000000000003', READER = '100000000000000004', OUTSIDER = '100000000000000009';
const ALICE = '100000000000000005', BOB = '100000000000000006';
const SERVER = '200000000000000001', OTHER = '200000000000000002';
const config: AdminConfig = { model: 'nimbus', jevModel: 'cirrus', embeddingModel: 'embed', baseUrl: 'https://models.example.com/v1', modelPrices: {}, fallbackPrice: { input: 1, cached_input: 1, output: 1 }, userLimit5hCostMicros: 100, userLimitWeekCostMicros: 0, userLimitGracePercent: 10 };
const members: TeamSnapshot['members'] = [{ id: DEVELOPER, role: 'developer', accepted: true }, { id: READER, role: 'read_only', accepted: true }];

/** Starts a console over the store. login(id) signs in as that Discord user and returns the headers for its requests. */
async function consoleFor(t: TestContext, store: SQLiteStore, options: Partial<ConsoleOptions> = {}) {
  const panel = new AdminPanel(config, store, new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 }), new MemberDirectory(fakeSource({})));
  const teams = new TeamAdmins({ async load() { return { ownerId: OWNER, members: [...members] }; } });
  const admin: ConsoleAdmin = { role: id => teams.role(id), canEdit: id => teams.canEdit(id), servers: async () => ({ servers: [], total: 0 }), serverChannels: async server => ({ server, channels: [] }), serverInfo: id => ({ name: id, icon: null }), setTranscript: async (server, channel, enabled) => ({ server, channel, enabled }), rotateWebhook: async () => ({}), panel };
  const server = createConsole({ origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, clientId: 'id', clientSecret: 'secret', settings: store, ...options }, { sessions: store, async canSignIn() { return true; },
    async snapshot() { return {}; }, async invoke() { return {}; }, admin,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  t.after(() => store.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, originalFetch = globalThis.fetch;
  let identity = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://discord.com/api/oauth2/token') return Response.json({ access_token: 'oauth-secret' });
    if (String(url) === 'https://discord.com/api/users/@me') return Response.json({ id: identity });
    return originalFetch(url, init);
  });
  const login = async (id: string) => {
    identity = id;
    const start = await originalFetch(base + '/auth/login', { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await originalFetch(base + `/auth/callback?state=${state}&code=x`, { redirect: 'manual', headers: { Cookie: `slopbot_state=${state}` } });
    const cookie = callback.headers.getSetCookie()[0]!.split(';')[0]!;
    const { csrf } = await (await originalFetch(base + '/api/settings', { headers: { Cookie: cookie } })).json() as { csrf: string };
    return { Cookie: cookie, Origin: 'http://localhost:3000', 'X-CSRF-Token': csrf };
  };
  const get = (path: string, session: Record<string, string> = {}) => originalFetch(base + path, { headers: session });
  const post = (path: string, body: unknown, session: Record<string, string>) => originalFetch(base + path, { method: 'POST', headers: { ...session, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { login, get, post };
}

test('status route shape', async t => {
  const store = new SQLiteStore();
  const { login, get } = await consoleFor(t, store, { llmStatus: user => user === ALICE ? { mode: 'offline', canChat: false } : { mode: 'fallback', canChat: true } });
  const alice = await login(ALICE), bob = await login(BOB);
  const offline = await get('/api/status', alice);
  assert.equal(offline.status, 200);
  assert.deepEqual(await offline.json(), { mode: 'offline', canChat: false });
  assert.deepEqual(await (await get('/api/status', bob)).json(), { mode: 'fallback', canChat: true });
});

test('status needs sign-in', async t => {
  const store = new SQLiteStore();
  const { get } = await consoleFor(t, store, { llmStatus: () => ({ mode: 'offline', canChat: false }) });
  assert.equal((await get('/api/status')).status, 401);
});

test('non-zdr writes only own user', async t => {
  const store = new SQLiteStore();
  const { login, get, post } = await consoleFor(t, store);
  const alice = await login(ALICE), bob = await login(BOB);
  assert.deepEqual(await (await get('/api/settings/non-zdr', alice)).json(), { allow: false });

  assert.deepEqual(await (await post('/api/settings/non-zdr', { allow: true }, alice)).json(), { allow: true });
  assert.deepEqual(store.setting(GLOBAL_SETTINGS_SCOPE, USER_NON_ZDR_SETTING), { [ALICE]: true });
  assert.deepEqual(await (await post('/api/settings/non-zdr', { allow: true }, bob)).json(), { allow: true });
  assert.deepEqual(store.setting(GLOBAL_SETTINGS_SCOPE, USER_NON_ZDR_SETTING), { [ALICE]: true, [BOB]: true }, 'bob does not replace alice');

  assert.deepEqual(await (await post('/api/settings/non-zdr', { allow: false }, alice)).json(), { allow: false });
  assert.deepEqual(store.setting(GLOBAL_SETTINGS_SCOPE, USER_NON_ZDR_SETTING), { [BOB]: true }, 'alice opts out; bob keeps his opt-in');
  assert.deepEqual(await (await get('/api/settings/non-zdr', bob)).json(), { allow: true });
  assert.deepEqual(await (await get('/api/settings/non-zdr', alice)).json(), { allow: false });

  const refused = await post('/api/settings/non-zdr', { allow: 'yes' }, alice);
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'Send allow as true or false.' });
  assert.deepEqual(store.setting(GLOBAL_SETTINGS_SCOPE, USER_NON_ZDR_SETTING), { [BOB]: true }, 'a refused save changes nothing');
});

test('server non-zdr needs editor', async t => {
  const store = new SQLiteStore();
  const { login, get, post } = await consoleFor(t, store);
  const outsider = await login(OUTSIDER), reader = await login(READER), developer = await login(DEVELOPER);

  assert.equal((await get(`/api/admin/servers/non-zdr?server=${SERVER}`, outsider)).status, 403, 'a non member cannot read');
  assert.equal((await post('/api/admin/servers/non-zdr', { server: SERVER, allow: true }, outsider)).status, 403, 'a non member cannot save');

  assert.deepEqual(await (await get(`/api/admin/servers/non-zdr?server=${SERVER}`, reader)).json(), { allow: false });
  assert.equal((await post('/api/admin/servers/non-zdr', { server: SERVER, allow: true }, reader)).status, 403, 'a read only member cannot save');
  assert.equal(store.setting(SERVER, SERVER_NON_ZDR_SETTING), undefined);

  const bad = await post('/api/admin/servers/non-zdr', { server: '12', allow: true }, developer);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'Invalid server.' });

  const saved = await post('/api/admin/servers/non-zdr', { server: SERVER, allow: true }, developer);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { allow: true });
  assert.equal(store.setting(SERVER, SERVER_NON_ZDR_SETTING), true);
  assert.equal(store.setting(OTHER, SERVER_NON_ZDR_SETTING), undefined, 'other servers keep their own value');
  assert.deepEqual(await (await get(`/api/admin/servers/non-zdr?server=${SERVER}`, reader)).json(), { allow: true });
});
