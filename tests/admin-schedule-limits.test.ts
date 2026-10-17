import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { AdminPanel, type AdminConfig } from '../src/admin-panel.js';
import { createConsole, type ConsoleAdmin } from '../src/web-console.js';
import { TeamAdmins, type TeamSnapshot } from '../src/team-admins.js';
import { UserLimiter } from '../src/user-limiter.js';
import { MemberDirectory } from '../src/member-directory.js';
import { DEFAULT_SCHEDULE_LIMITS, SCHEDULE_LIMITS_KEY } from '../src/schedules/schedule-types.js';
import { GLOBAL_SETTINGS_SCOPE } from '../src/usage-cost.js';
import { fakeSource } from './member-fakes.js';

const OWNER = '100000000000000001', DEVELOPER = '100000000000000003', READER = '100000000000000004', OUTSIDER = '100000000000000009';
const config: AdminConfig = { model: 'nimbus', jevModel: 'cirrus', embeddingModel: 'embed', baseUrl: 'https://models.example.com/v1', modelPrices: {}, fallbackPrice: { input: 1, cached_input: 1, output: 1 }, userLimit5hCostMicros: 100, userLimitWeekCostMicros: 0, userLimitGracePercent: 10 };
const valid = { perServer: 20, perUser: 5, minMinutes: { message: 30, prompt: 90, tool: 120 } };

function setup() {
  const store = new SQLiteStore();
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 });
  const panel = new AdminPanel(config, store, limiter, new MemberDirectory(fakeSource({})));
  return { store, panel };
}

test('minimum minutes accept 1 and 10080, and refuse 0 and 10081 for each kind', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  for (const kind of ['message', 'prompt', 'tool'] as const) {
    for (const minutes of [1, 10080]) {
      const body = { ...valid, minMinutes: { ...valid.minMinutes, [kind]: minutes } };
      assert.deepEqual((await panel.saveScheduleLimits(body)).minMinutes[kind], minutes, `${kind} ${minutes}`);
    }
    const before = store.setting(GLOBAL_SETTINGS_SCOPE, SCHEDULE_LIMITS_KEY);
    for (const minutes of [0, 10081, 1.5, '30', undefined]) {
      const body = { ...valid, minMinutes: { ...valid.minMinutes, [kind]: minutes } };
      await assert.rejects(panel.saveScheduleLimits(body), /Minimum minutes for .* must be a whole number from 1 to 10080\./, `${kind} ${String(minutes)}`);
    }
    assert.deepEqual(store.setting(GLOBAL_SETTINGS_SCOPE, SCHEDULE_LIMITS_KEY), before, `a refused ${kind} save changes nothing`);
  }
});

function consoleAdmin(teams: TeamAdmins, panel: AdminPanel): ConsoleAdmin {
  return { role: id => teams.role(id), canEdit: id => teams.canEdit(id), servers: async () => ({ servers: [], total: 0 }), serverChannels: async server => ({ server, channels: [] }), serverInfo: id => ({ name: id, icon: null }), setTranscript: async (server, channel, enabled) => ({ server, channel, enabled }), rotateWebhook: async () => ({}), panel };
}

/** Starts a console with the team below. login(id) signs in as that Discord user and returns the headers for its requests. */
async function teamConsole(t: TestContext, store: SQLiteStore, panel: AdminPanel, members: TeamSnapshot['members']) {
  const teams = new TeamAdmins({ async load() { return { ownerId: OWNER, members: [...members] }; } });
  const server = createConsole({ origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, clientId: 'id', clientSecret: 'secret' }, { sessions: new SQLiteStore(), async canSignIn() { return true; },
    async snapshot() { return {}; }, async invoke() { return {}; }, admin: consoleAdmin(teams, panel),
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
  const get = (path: string, session: Record<string, string>) => originalFetch(base + path, { headers: session });
  const post = (path: string, body: unknown, session: Record<string, string>) => originalFetch(base + path, { method: 'POST', headers: { ...session, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { login, get, post };
}

test('schedule limits route: members read, only editors save', async t => {
  const store = new SQLiteStore();
  const panel = new AdminPanel(config, store, new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 }), new MemberDirectory(fakeSource({})));
  const members: TeamSnapshot['members'] = [{ id: DEVELOPER, role: 'developer', accepted: true }, { id: READER, role: 'read_only', accepted: true }];
  const { login, get, post } = await teamConsole(t, store, panel, members);
  const outsider = await login(OUTSIDER), reader = await login(READER), developer = await login(DEVELOPER);

  assert.equal((await get('/api/admin/schedule-limits', outsider)).status, 403, 'a non member cannot read');
  assert.equal((await post('/api/admin/schedule-limits', valid, outsider)).status, 403, 'a non member cannot save');

  const read = await get('/api/admin/schedule-limits', reader);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { ...DEFAULT_SCHEDULE_LIMITS, default: DEFAULT_SCHEDULE_LIMITS });

  assert.equal((await post('/api/admin/schedule-limits', valid, reader)).status, 403, 'a read only member cannot save');
  assert.equal(store.setting(GLOBAL_SETTINGS_SCOPE, SCHEDULE_LIMITS_KEY), undefined);

  const refused = await post('/api/admin/schedule-limits', { ...valid, perUser: 0 }, developer);
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'Per user must be a whole number from 1 to 1000.' });

  const saved = await post('/api/admin/schedule-limits', valid, developer);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ...valid, default: DEFAULT_SCHEDULE_LIMITS });
  assert.deepEqual(await (await get('/api/admin/schedule-limits', reader)).json(), { ...valid, default: DEFAULT_SCHEDULE_LIMITS });
});
