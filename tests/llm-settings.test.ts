import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { AdminInputError, AdminPanel, type AdminConfig } from '../src/admin-panel.js';
import { createConsole, type ConsoleAdmin } from '../src/web-console.js';
import { TeamAdmins, type TeamSnapshot } from '../src/team-admins.js';
import { UserLimiter } from '../src/user-limiter.js';
import { MemberDirectory } from '../src/member-directory.js';
import { GLOBAL_SETTINGS_SCOPE } from '../src/usage-cost.js';
import { WebKeySecrets } from '../src/web-keys.js';
import { DEFAULT_BREAKER, DEFAULT_STATUS_NOTE_MINUTES, LLM_DEGRADED_SETTING, LLM_FALLBACK_KEY_ID } from '../src/llm-mode.js';
import { fakeSource } from './member-fakes.js';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const SECRET = 'fb-secret-1234';
const OWNER = '100000000000000001', DEVELOPER = '100000000000000003', READER = '100000000000000004', OUTSIDER = '100000000000000009';
const config: AdminConfig = { model: 'nimbus', jevModel: 'cirrus', embeddingModel: 'embed', baseUrl: 'https://models.example.com/v1', modelPrices: {}, fallbackPrice: { input: 1, cached_input: 1, output: 1 }, userLimit5hCostMicros: 100, userLimitWeekCostMicros: 0, userLimitGracePercent: 10 };
const endpoint = { baseUrl: 'https://fallback.example.com/v1', model: 'cloud-model', zdr: false, contextTokens: 32768, outputTokens: 2048 };
const defaults = { override: 'auto', breaker: DEFAULT_BREAKER, statusNoteMinutes: DEFAULT_STATUS_NOTE_MINUTES };

function setup(secrets = new WebKeySecrets(KEY)) {
  const store = new SQLiteStore();
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 });
  const panel = new AdminPanel(config, store, limiter, new MemberDirectory(fakeSource({})), undefined, secrets);
  return { store, panel, secrets };
}

/** The fallback as saved, with its sealed key. */
function savedFallback(store: SQLiteStore) {
  return (store.setting(GLOBAL_SETTINGS_SCOPE, LLM_DEGRADED_SETTING) as { fallback: { keySealed?: string; keyLast4?: string; model: string } }).fallback;
}

test('rejects http and credentials in baseUrl', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  for (const baseUrl of ['http://fallback.example.com/v1', 'https://user:pw@fallback.example.com/v1', 'https://fallback.example.com/v1?x=1', 'https://fallback.example.com/v1#frag', 'ftp://fallback.example.com', 'not a url', 42]) {
    await assert.rejects(panel.saveLlm({ fallback: { ...endpoint, baseUrl } }), (error: unknown) => error instanceof AdminInputError && /base URL/.test(error.message), String(baseUrl));
  }
  assert.equal(store.setting(GLOBAL_SETTINGS_SCOPE, LLM_DEGRADED_SETTING), undefined, 'refused saves change nothing');
});

test('rejects output >= context', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  await assert.rejects(panel.saveLlm({ fallback: { ...endpoint, contextTokens: 8192, outputTokens: 8192 } }), (error: unknown) => error instanceof AdminInputError && /less than context/.test(error.message));
  await assert.rejects(panel.saveLlm({ fallback: { ...endpoint, contextTokens: 8192, outputTokens: 9000 } }), /less than context/);
  await assert.rejects(panel.saveLlm({ fallback: { ...endpoint, contextTokens: 32768, outputTokens: 127 } }), /Output tokens must be a whole number from 128 to 100000/);
  await assert.rejects(panel.saveLlm({ fallback: { ...endpoint, contextTokens: 2047, outputTokens: 128 } }), /Context tokens must be a whole number from 2048 to 1000000/);
  assert.equal(store.setting(GLOBAL_SETTINGS_SCOPE, LLM_DEGRADED_SETTING), undefined, 'refused saves change nothing');
  await panel.saveLlm({ fallback: { ...endpoint, contextTokens: 8192, outputTokens: 8191 } });
  assert.equal(savedFallback(store).model, 'cloud-model', 'one below the context is allowed');
});

test('seals key and hides it', async t => {
  const { store, panel, secrets } = setup(); t.after(() => store.close());
  const view = await panel.saveLlm({ fallback: { ...endpoint, key: `  ${SECRET}  ` } });
  const saved = savedFallback(store);
  assert.equal(saved.keyLast4, '1234');
  assert.notEqual(saved.keySealed, SECRET);
  assert.equal(secrets.open(saved.keySealed!, LLM_FALLBACK_KEY_ID), SECRET, 'the sealed value opens to the original');
  assert.throws(() => secrets.open(saved.keySealed!, 'another-row'), 'the seal is bound to its id');
  assert.doesNotMatch(JSON.stringify(view), /keySealed|fb-secret/);
  assert.deepEqual(view.settings.fallback, { ...endpoint, keyLast4: '1234' });
});

test('drops key when origin changes', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  await panel.saveLlm({ fallback: { ...endpoint, key: SECRET } });
  await panel.saveLlm({ fallback: { ...endpoint, baseUrl: 'https://fallback.example.com/v2' } });
  assert.notEqual(savedFallback(store).keySealed, undefined, 'a path change on the same origin keeps the key');
  const moved = await panel.saveLlm({ fallback: { ...endpoint, baseUrl: 'https://attacker.example.net/v1' } });
  assert.equal(Object.hasOwn(savedFallback(store), 'keySealed'), false, 'a new host gets no saved key');
  assert.equal(Object.hasOwn(savedFallback(store), 'keyLast4'), false);
  assert.equal(moved.settings.fallback?.baseUrl, 'https://attacker.example.net/v1');
});

test('test reuses primary key on same origin', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const panel = new AdminPanel({ ...config, baseUrl: endpoint.baseUrl, apiKey: 'primary-key-9999' }, store, new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 }), new MemberDirectory(fakeSource({})), undefined, new WebKeySecrets(KEY));
  await panel.saveLlm({ fallback: endpoint });
  const auth: (string | null)[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => { auth.push((init!.headers as Record<string, string>).Authorization ?? null); return Response.json({ choices: [] }); });

  await panel.testLlm();
  await panel.saveLlm({ fallback: { ...endpoint, baseUrl: 'https://other.example.net/v1' } });
  await panel.testLlm();
  assert.deepEqual(auth, ['Bearer primary-key-9999', null], 'the primary key goes to the primary origin only');
});

function consoleAdmin(teams: TeamAdmins, panel: AdminPanel): ConsoleAdmin {
  return { role: id => teams.role(id), canEdit: id => teams.canEdit(id), servers: async () => ({ servers: [], total: 0 }), serverChannels: async server => ({ server, channels: [] }), serverInfo: id => ({ name: id, icon: null }), setTranscript: async (server, channel, enabled) => ({ server, channel, enabled }), rotateWebhook: async () => ({}), panel };
}

/** Starts a console with the team below. login(id) signs in as that Discord user and returns the headers for its requests. */
async function teamConsole(t: TestContext, panel: AdminPanel, members: TeamSnapshot['members']) {
  const teams = new TeamAdmins({ async load() { return { ownerId: OWNER, members: [...members] }; } });
  const sessions = new SQLiteStore(); t.after(() => sessions.close());
  const server = createConsole({ origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, clientId: 'id', clientSecret: 'secret' }, { sessions, async canSignIn() { return true; },
    async snapshot() { return {}; }, async invoke() { return {}; }, admin: consoleAdmin(teams, panel),
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
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
  const get = (path: string, session: Record<string, string>) => originalFetch(base + path, { headers: session });
  const post = (path: string, body: unknown, session: Record<string, string>) => originalFetch(base + path, { method: 'POST', headers: { ...session, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { login, get, post };
}

const members: TeamSnapshot['members'] = [{ id: DEVELOPER, role: 'developer', accepted: true }, { id: READER, role: 'read_only', accepted: true }];

test('GET never returns keySealed', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const panel = new AdminPanel(config, store, new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 }), new MemberDirectory(fakeSource({})), undefined, new WebKeySecrets(KEY));
  const { login, get } = await teamConsole(t, panel, members);
  await panel.saveLlm({ fallback: { ...endpoint, key: SECRET } });
  for (const id of [DEVELOPER, READER]) {
    const response = await get('/api/admin/llm', await login(id));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(text, /keySealed|fb-secret/, id);
    assert.match(text, /"keyLast4":"1234"/, id);
  }
});

test('llm routes: members read, only editors save, test needs a saved fallback', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const panel = new AdminPanel(config, store, new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 }), new MemberDirectory(fakeSource({})), undefined, new WebKeySecrets(KEY));
  const { login, get, post } = await teamConsole(t, panel, members);
  const outsider = await login(OUTSIDER), reader = await login(READER), developer = await login(DEVELOPER);

  assert.equal((await get('/api/admin/llm', outsider)).status, 403, 'a non member cannot read');
  assert.equal((await post('/api/admin/llm', { override: 'offline' }, outsider)).status, 403, 'a non member cannot save');
  assert.equal((await post('/api/admin/llm', { override: 'offline' }, reader)).status, 403, 'a read only member cannot save');
  assert.equal((await post('/api/admin/llm/test', {}, reader)).status, 403, 'a read only member cannot test');
  assert.equal(store.setting(GLOBAL_SETTINGS_SCOPE, LLM_DEGRADED_SETTING), undefined);

  const read = await get('/api/admin/llm', reader);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { settings: defaults, state: { mode: 'normal', source: 'breaker', since: 0 } });

  const refused = await post('/api/admin/llm', { breaker: { failures: 0 } }, developer);
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'Breaker failures must be a whole number from 1 to 100.' });

  assert.equal((await post('/api/admin/llm/test', {}, developer)).status, 400, 'no fallback to test yet');

  const saved = await post('/api/admin/llm', { override: 'offline', fallback: { ...endpoint, key: SECRET } }, developer);
  assert.equal(saved.status, 200);
  const body = await saved.json() as { settings: { override: string; fallback: unknown } };
  assert.equal(body.settings.override, 'offline');
  assert.deepEqual(body.settings.fallback, { ...endpoint, keyLast4: '1234' });
});
