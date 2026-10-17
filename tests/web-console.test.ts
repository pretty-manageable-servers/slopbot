import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleOptions, createConsole } from '../src/web-console.js';
import { ToolError } from '../src/tools.js';

import { SQLiteStore } from '../src/adapters/sqlite.js';
import { AdminPanel, pageItems, type UserDetailView, type UsersPageView } from '../src/admin-panel.js';
import { DEFAULT_INSTRUCTIONS } from '../src/agent-runner.js';

import { TeamAdmins, type TeamSnapshot } from '../src/team-admins.js';
import { USER_LIMIT_OVERRIDES_SETTING, UserLimiter } from '../src/user-limiter.js';
import type { KnownUserRow, UserTokenTotalRow } from '../src/ports.js';

import type { ConsoleAdmin } from '../src/web-console.js';
import { MemberDirectory } from '../src/member-directory.js';
import { fakeSource } from './member-fakes.js';

type PriceBody = { input: number; cached_input: number; output: number };
type PricesBody = { fallback: PriceBody; models: { model: string; default: PriceBody & { source: string }; override: PriceBody | null }[] };

test('web console is opt-in and rejects insecure public origins', () => {
  assert.equal(consoleOptions({}), undefined);
  assert.throws(() => consoleOptions({WEB_ENABLED:'true',WEB_ORIGIN:'http://example.com'}), /HTTPS/);
  assert.throws(() => consoleOptions({WEB_ENABLED:'true',WEB_ORIGIN:'https://slopbot.pmservers.org/console',DISCORD_CLIENT_ID:'id',DISCORD_CLIENT_SECRET:'secret'}), /without a path/);
  assert.throws(() => consoleOptions({WEB_ENABLED:'true'}), /CLIENT_ID/);
});

test('Discord login binds state to browser, protects writes, and destroys logout sessions', async t => {
  let user = '', name = '', deny = false;
  const server = createConsole({origin:'http://localhost:3000',host:'127.0.0.1',port:3000,clientId:'id',clientSecret:'secret'}, { sessions: new SQLiteStore(), async canSignIn() { return true; },
    async snapshot(id) { if (deny) throw new ToolError('Membership revoked'); return {user:id}; },
    async invoke(id, _server, _channel, tool) { if (deny) throw new ToolError('Permission revoked'); user=id;name=tool;return {text:'Saved'}; },
    async mcp(id, _server, input) { if (deny) throw new ToolError('Manage Server permission is required.'); user=id;name='mcp';return {text:'Connected',input}; },
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise<void>(resolve => server.close(()=>resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, originalFetch = globalThis.fetch;
  const call = (path:string, options?: RequestInit) => originalFetch(base+path, options);
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request, init?:RequestInit) => {
    if (String(url) === 'https://discord.com/api/oauth2/token') return Response.json({access_token:'oauth-secret'});
    if (String(url) === 'https://discord.com/api/users/@me') return Response.json({id:'123456789012345678'});
    return originalFetch(url,init);
  });
  assert.equal((await call('/api/settings')).status,401);
  const login = await call('/auth/login',{redirect:'manual'});
  assert.match(login.headers.get('set-cookie')!,/Path=\//);
  const auth = new URL(login.headers.get('location')!);
  assert.equal(auth.searchParams.get('redirect_uri'),'http://localhost:3000/auth/callback');
  const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
  assert.equal((await call(`/auth/callback?state=${state}&code=x`,{redirect:'manual'})).status,400);
  const callback = await call(`/auth/callback?state=${state}&code=x`,{redirect:'manual',headers:{Cookie:`slopbot_state=${state}`}});
  assert.equal(callback.status,302);
  assert.equal(callback.headers.get('location'),'/console');
  const cookie = callback.headers.getSetCookie()[0]!.split(';')[0]!;
  assert.ok(cookie.includes('slopbot_session='));
  assert.equal((await call(`/auth/callback?state=${state}&code=x`,{headers:{Cookie:`slopbot_state=${state}`}})).status,400);
  const snapshot = await call('/api/settings',{headers:{Cookie:cookie}});
  const data = await snapshot.json() as {csrf:string};
  assert.ok(data.csrf);
  const body = JSON.stringify({channel:'123456789012345679',name:'monitoring',args:{enabled:true}});
  assert.equal((await call('/api/settings',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body})).status,403);
  const headers = {Cookie:cookie,'Content-Type':'application/json',Origin:'http://localhost:3000','X-CSRF-Token':data.csrf};
  assert.equal((await call('/api/settings',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body})).status,403);
  assert.equal((await call('/api/settings',{method:'POST',headers,body})).status,200);
  assert.equal(user,'123456789012345678');assert.equal(name,'monitoring');
  assert.equal((await call('/api/settings',{method:'POST',headers,body:JSON.stringify({channel:'123456789012345679',name:'tool_display',args:{mode:'full'}})})).status,200);
  assert.equal(name,'tool_display');
  const mcpBody=JSON.stringify({action:'save',id:'github',url:'https://example.com/mcp',tools:[]});
  assert.equal((await call('/api/mcp',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:mcpBody})).status,403);
  assert.equal((await call('/api/mcp',{method:'POST',headers,body:mcpBody})).status,200);
  assert.equal(name,'mcp');assert.equal(user,'123456789012345678');
  assert.equal((await call('/api/settings',{method:'POST',headers,body:JSON.stringify({channel:'x',name:'task_start',args:{}})})).status,400);
  assert.equal((await call('/api/settings',{method:'POST',headers,body:'null'})).status,400);
  deny=true;
  assert.equal((await call('/api/mcp',{method:'POST',headers,body:mcpBody})).status,403);
  assert.equal((await call('/api/settings',{headers:{Cookie:cookie}})).status,403);
  assert.equal((await call('/api/settings',{method:'POST',headers,body})).status,403);
  assert.equal((await call('/api/logout',{method:'POST',headers,body:'{}'})).status,200);
  assert.equal((await call('/api/settings',{headers:{Cookie:cookie}})).status,401);
});

test('landing serves the static export, console serves under /console, and traversal is blocked',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'slopbot-site-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'site/out/_next/static/chunks'),{recursive:true});
  await writeFile(join(dir,'site/out/index.html'),'<!doctype html><title>Slopbot</title><script>window.landing=true</script>');
  await writeFile(join(dir,'site/out/_next/static/chunks/app.js'),'console.log(1)');
  await writeFile(join(dir,'site/out/favicon.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(dir,'site/out/404.html'),'<!doctype html>');
  await writeFile(join(dir,'site/out/terms.html'),'<!doctype html><title>Terms</title>');
  await writeFile(join(dir,'secret.txt'),'secret');
  const server=createConsole({origin:'http://localhost:3000',host:'127.0.0.1',port:3000,clientId:'id',clientSecret:'secret',siteDir:join(dir,'site/out')},{ sessions: new SQLiteStore(), async canSignIn() { return true; },async snapshot(){return {};},async invoke(){return {};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`;
  // Landing page: inline scripts are allowed only here.
  const home=await fetch(base+'/');assert.match(await home.text(),/window\.landing/);
  assert.match(home.headers.get('content-security-policy')!,/script-src 'self' 'unsafe-inline'/);
  assert.equal((await fetch(base+'/_next/static/chunks/app.js')).headers.get('content-type'),'text/javascript');
  assert.equal((await fetch(base+'/favicon.svg')).headers.get('content-type'),'image/svg+xml');
  assert.equal((await fetch(base+'/404.html')).status,200);
  // A page of the export is served without .html, with the landing CSP.
  const terms=await fetch(base+'/terms');assert.match(await terms.text(),/<title>Terms/);
  assert.match(terms.headers.get('content-security-policy')!,/script-src 'self' 'unsafe-inline'/);
  assert.equal((await fetch(base+'/missing-page')).status,404);
  assert.equal((await fetch(base+'/_next/static/chunks/missing.js')).status,404);
  assert.equal((await fetch(base+'/_next/static/chunks/')).status,404);
  assert.equal((await fetch(base+'/_next/../../secret.txt')).status,404);
  assert.equal((await fetch(base+'/_next/static/..%2f..%2fsecret.txt')).status,404);
  assert.equal((await fetch(base+'/secret.txt')).status,404);
  assert.equal((await fetch(base+'/.env')).status,404);
  assert.equal((await fetch(base+'/app.js')).status,404);
  // Console: its own paths and CSP, with no inline scripts.
  const page=await fetch(base+'/console');assert.match(await page.text(),/Your team\. Your Slopbot/);
  assert.match(page.headers.get('content-security-policy')!,/script-src 'self';/);
  assert.equal((await fetch(base+'/console/')).status,200);
  assert.equal((await fetch(base+'/console/app.js')).headers.get('content-type'),'text/javascript');
  assert.equal((await fetch(base+'/console/style.css')).headers.get('content-type'),'text/css');
  assert.equal((await fetch(base+'/console/assets/logo-light.svg')).status,200);
  assert.equal((await fetch(base+'/console/assets/inter-latin-wght-normal.woff2')).headers.get('content-type'),'font/woff2');
  assert.equal((await fetch(base+'/console/assets/%2e%2e%2f.env')).status,404);
  assert.equal((await fetch(base+'/console/../package.json')).status,404);
  assert.equal((await fetch(base+'/style.css')).status,404);
  assert.equal((await fetch(base+'/assets/logo-light.svg')).status,404);
});

const teamConfig = { model: 'nimbus', jevModel: 'cirrus', embeddingModel: 'embed', baseUrl: 'https://models.example.com/v1', modelPrices: {}, fallbackPrice: { input: 1, cached_input: 1, output: 1 }, userLimit5hCostMicros: 100, userLimitWeekCostMicros: 0, userLimitGracePercent: 10 };

/** Stands in for the store queries of the known users until they land: the rows are searched by name substring or exact ID, and paged in the given order. */
function stubKnownUsers(store: SQLiteStore, rows: KnownUserRow[], totals: Record<string, (UserTokenTotalRow & { server: string })[]> = {}): void {
  store.listKnownUsers = async (search, limit, offset) => {
    const needle = search.trim().toLowerCase();
    const matches = rows.filter(row => !needle || row.user === needle || row.names.some(name => name.toLowerCase().includes(needle)));
    return { total: matches.length, users: matches.slice(offset, offset + limit) };
  };
  store.userTokenTotalsByServer = async user => totals[user] ?? [];
}

/** The team admin backend over a panel. Roles come from the team, which is read on each request. */
function consoleAdmin(teams: TeamAdmins, panel: AdminPanel, serverInfo: ConsoleAdmin['serverInfo']): ConsoleAdmin {
  return { role: id => teams.role(id), canEdit: id => teams.canEdit(id), servers: async () => ({ servers: [], total: 0 }), serverChannels: async server => ({ server, channels: [] }), serverInfo, setTranscript: async (server, channel, enabled) => ({ server, channel, enabled }), rotateWebhook: async () => ({}), panel };
}

/** Starts a console with that admin backend. login(id) signs in as that Discord user and returns the headers for its requests. */
async function teamConsole(t: TestContext, members: TeamSnapshot['members'], build: (teams: TeamAdmins) => ConsoleAdmin) {
  const OWNER = '100000000000000001';
  const teams = new TeamAdmins({ async load() { return { ownerId: OWNER, members: [...members] }; } });
  const server = createConsole({ origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, clientId: 'id', clientSecret: 'secret' }, { sessions: new SQLiteStore(), async canSignIn() { return true; },
    async snapshot() { return {}; }, async invoke() { return {}; }, admin: build(teams),
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

test('reset, grant and override need an editor', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const DEVELOPER = '100000000000000003', READER = '100000000000000004', OUTSIDER = '100000000000000005', USER = '100000000000000007', SERVER = '200000000000000001';
  stubKnownUsers(store, [{ user: USER, names: ['Ada L'], servers: [SERVER] }]);
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 });
  const panel = new AdminPanel(teamConfig, store, limiter, new MemberDirectory(fakeSource({})));
  const members: TeamSnapshot['members'] = [{ id: DEVELOPER, role: 'developer', accepted: true }, { id: READER, role: 'read_only', accepted: true }];
  const { login, post } = await teamConsole(t, members, teams => consoleAdmin(teams, panel, () => ({ name: 'Test server', icon: null })));
  const outsider = await login(OUTSIDER), reader = await login(READER), developer = await login(DEVELOPER);
  await limiter.record(USER, 60, Date.now());
  const writes: [string, unknown][] = [
    ['/api/admin/users/reset', { user: USER, kind: '5h' }],
    ['/api/admin/users/grant', { user: USER, kind: 'week', count: 2 }],
    ['/api/admin/users/override', { user: USER, five_hour_cost_micros: 1000, week_cost_micros: null }],
  ];

  // Outsiders and read-only members are refused, and nothing changes.
  for (const [path, body] of writes) {
    assert.equal((await post(path, body, outsider)).status, 403, path);
    assert.equal((await post(path, body, reader)).status, 403, path);
  }
  assert.equal((await store.userUsage('global', USER)).windows[0]!.spent, 60);
  assert.equal((await store.userUsage('global', USER)).resets.week, undefined);
  assert.equal(store.setting('global', USER_LIMIT_OVERRIDES_SETTING), undefined);

  // An editor's reset clears the window and returns the user's detail.
  const reset = await post('/api/admin/users/reset', { user: USER, kind: '5h' }, developer);
  assert.equal(reset.status, 200);
  assert.deepEqual((await reset.json() as UserDetailView).windows.map(window => [window.kind, window.spent]), [['5h', 0], ['week', 60]]);

  // A grant adds banked resets: 1 to 100 for one window.
  const granted = await post('/api/admin/users/grant', { user: USER, kind: 'week', count: 2 }, developer);
  assert.equal(granted.status, 200);
  assert.equal((await granted.json() as UserDetailView).windows.find(window => window.kind === 'week')!.banked, 2);
  for (const bad of [{ user: USER, kind: 'week', count: 0 }, { user: USER, kind: 'week', count: 101 }, { user: USER, kind: 'month', count: 1 }]) {
    assert.equal((await post('/api/admin/users/grant', bad, developer)).status, 400, JSON.stringify(bad));
  }

  // An override saves one user's values; bad values save nothing.
  const saved = await post('/api/admin/users/override', { user: USER, five_hour_cost_micros: 1000, week_cost_micros: null }, developer);
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json() as UserDetailView).override, { five_hour_cost_micros: 1000, week_cost_micros: null });
  for (const bad of [
    { user: USER, five_hour_cost_micros: -1, week_cost_micros: null },
    { user: USER, five_hour_cost_micros: 1.5, week_cost_micros: null },
    { user: USER, five_hour_cost_micros: 1 },
    { user: USER, five_hour_cost_micros: 'x', week_cost_micros: null },
    { user: 'bad', five_hour_cost_micros: 1, week_cost_micros: null },
  ]) {
    assert.equal((await post('/api/admin/users/override', bad, developer)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(store.setting('global', USER_LIMIT_OVERRIDES_SETTING), { [USER]: { five_hour_cost_micros: 1000, week_cost_micros: null } });

  // Both null clears the override, and the user is back on the global limit.
  const cleared = await post('/api/admin/users/override', { user: USER, five_hour_cost_micros: null, week_cost_micros: null }, developer);
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as UserDetailView).override, null);
  assert.deepEqual(store.setting('global', USER_LIMIT_OVERRIDES_SETTING), {});
});

test('team admin routes need team membership, and only editors can change settings', async t => {
  const store = new SQLiteStore(), OWNER = '100000000000000001', DEVELOPER = '100000000000000003', READER = '100000000000000004', OUTSIDER = '100000000000000005', USER = '100000000000000007';
  const SERVER = '200000000000000001';
  stubKnownUsers(store, [{ user: USER, names: ['Ada L'], servers: [SERVER] }]);
  let members: TeamSnapshot['members'] = [{ id: DEVELOPER, role: 'developer', accepted: true }, { id: READER, role: 'read_only', accepted: true }];
  const teams = new TeamAdmins({ async load() { return { ownerId: OWNER, members: [...members] }; } });
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 });
  const AVATAR = 'https://cdn.discordapp.com/guilds/1/users/7/avatar.png';
  const directory = new MemberDirectory(fakeSource({ [DEVELOPER]: { username: 'dev', inServer: true }, [READER]: { username: 'reader', inServer: true }, [USER]: { username: 'ada', nickname: 'Ada L', serverAvatar: AVATAR, inServer: true, email: 'ada@example.com' } }));
  const panel = new AdminPanel({ model: 'nimbus', jevModel: 'cirrus', embeddingModel: 'embed', baseUrl: 'https://models.example.com/v1', modelPrices: {}, fallbackPrice: { input: 1, cached_input: 1, output: 1 }, userLimit5hCostMicros: 100, userLimitWeekCostMicros: 0, userLimitGracePercent: 10 }, store, limiter, directory);
  const rotated: string[] = [];
  const serverRows = [{ id: SERVER, name: 'Test server', channelCount: 0, transcriptsOn: 0 }];
  const admin: ConsoleAdmin = { role: id => teams.role(id), canEdit: id => teams.canEdit(id), servers: async page => pageItems(serverRows, page), serverChannels: async server => ({ server, name: 'Test server', channels: [] }), serverInfo: id => ({ name: id === SERVER ? 'Test server' : id, icon: null }), setTranscript: async (server, channel, enabled) => ({ server, channel, enabled }), rotateWebhook: async (_server, channel) => { rotated.push(channel); return { webhookId: 'hook-2' }; }, panel };
  const server = createConsole({origin:'http://localhost:3000',host:'127.0.0.1',port:3000,clientId:'id',clientSecret:'secret'}, { sessions: new SQLiteStore(), async canSignIn() { return true; },
    async snapshot() { return {}; }, async invoke() { return {}; }, admin,
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  t.after(() => store.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, originalFetch = globalThis.fetch;
  let identity = '';
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://discord.com/api/oauth2/token') return Response.json({access_token:'oauth-secret'});
    if (String(url) === 'https://discord.com/api/users/@me') return Response.json({id: identity});
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
  const outsider = await login(OUTSIDER), reader = await login(READER), developer = await login(DEVELOPER);
  const reads = ['/api/admin/me', '/api/admin/limits', '/api/admin/users?limit=10', `/api/admin/users/one?user=${USER}`, '/api/admin/prices', '/api/admin/system-prompt', '/api/admin/servers', '/api/admin/servers?q=test&offset=0&limit=50', `/api/admin/servers/channels?server=${SERVER}`, '/api/admin/usage/total', '/api/admin/system-prompt/full'];
  const writes: [string, unknown][] = [
    ['/api/admin/limits', { five_hour_cost_micros: 5000000, week_cost_micros: 20000000, grace_percent: 15 }],
    ['/api/admin/prices', { model: 'stratus', input: 1000000, cached_input: 100000, output: 4000000 }],
    ['/api/admin/users/reset', { user: USER, kind: '5h' }],
    ['/api/admin/users/grant', { user: USER, kind: '5h', count: 1 }],
    ['/api/admin/users/override', { user: USER, five_hour_cost_micros: 1000, week_cost_micros: null }],
    ['/api/admin/transcripts', { server: SERVER, channel: '300000000000000001', enabled: true }],
    ['/api/admin/web-webhooks/rotate', { server: SERVER, channel: '300000000000000001' }],
    ['/api/admin/system-prompt', { text: 'Be brief.' }],
  ];

  // Not a member: every admin route is refused.
  for (const path of reads) assert.equal((await get(path, outsider)).status, 403, path);
  for (const [path, body] of writes) assert.equal((await post(path, body, outsider)).status, 403, path);
  assert.equal((await get('/api/admin/me', {})).status, 401, 'no session is still 401');

  // Read-only member: reads work, writes are refused and change nothing.
  assert.deepEqual(await (await get('/api/admin/me', reader)).json(), { role: 'read_only', canEdit: false });
  for (const path of reads) assert.equal((await get(path, reader)).status, 200, path);
  for (const [path, body] of writes) assert.equal((await post(path, body, reader)).status, 403, path);
  assert.equal(store.setting('global', 'user_limit_5h_cost_micros'), undefined);
  assert.equal((await post('/api/admin/limits', writes[0]![1], { ...reader, 'X-CSRF-Token': 'wrong', Origin: 'https://evil.example' })).status, 403);

  // Developer: reads and writes work.
  assert.deepEqual(await (await get('/api/admin/me', developer)).json(), { role: 'developer', canEdit: true });
  const limits = await post('/api/admin/limits', writes[0]![1], developer);
  assert.equal(limits.status, 200);
  assert.deepEqual(await limits.json(), { five_hour_cost_micros: 5000000, week_cost_micros: 20000000, grace_percent: 15, defaults: { five_hour_cost_micros: 100, week_cost_micros: 0, grace_percent: 10 } });
  assert.equal(store.setting('global', 'user_limit_week_cost_micros'), 20000000);
  for (const bad of [{ five_hour_cost_micros: -1, week_cost_micros: 0, grace_percent: 0 }, { five_hour_cost_micros: 1.5, week_cost_micros: 0, grace_percent: 0 }, { five_hour_cost_micros: 1, week_cost_micros: 0, grace_percent: 1001 }, { five_hour_cost_micros: 1, week_cost_micros: 'x', grace_percent: 0 }]) {
    assert.equal((await post('/api/admin/limits', bad, developer)).status, 400, JSON.stringify(bad));
  }
  assert.equal(store.setting('global', 'user_limit_5h_cost_micros'), 5000000, 'bad input saves nothing');
  assert.equal((await get('/api/admin/limits', developer)).status, 200);

  // Rotate: refused members rotate nothing; an editor rotates one channel's webhook and bad input rotates nothing.
  assert.deepEqual(rotated, []);
  const rotate = await post('/api/admin/web-webhooks/rotate', { server: SERVER, channel: '300000000000000001' }, developer);
  assert.equal(rotate.status, 200);
  assert.deepEqual(await rotate.json(), { webhookId: 'hook-2' });
  assert.deepEqual(rotated, ['300000000000000001']);
  assert.equal((await post('/api/admin/web-webhooks/rotate', { server: SERVER, channel: 'bad' }, developer)).status, 400);
  assert.deepEqual(rotated, ['300000000000000001']);

  // Prices: each row has the default (no config price, so the fallback) and the override. Save, then reset with remove.
  const priced = await (await post('/api/admin/prices', writes[1]![1], developer)).json() as PricesBody;
  const rowOf = (view: PricesBody, model: string) => view.models.find(item => item.model === model)!;
  assert.deepEqual(rowOf(priced, 'stratus'), { model: 'stratus', default: { input: 1, cached_input: 1, output: 1, source: 'fallback' }, override: { input: 1000000, cached_input: 100000, output: 4000000 } });
  assert.deepEqual(rowOf(priced, 'nimbus'), { model: 'nimbus', default: { input: 1, cached_input: 1, output: 1, source: 'fallback' }, override: null });
  assert.ok(priced.models.some(item => item.model === 'cirrus') && priced.models.some(item => item.model === 'embed'));
  assert.deepEqual(priced.fallback, { input: 1, cached_input: 1, output: 1 });
  for (const bad of [{ model: '', input: 1, cached_input: 1, output: 1 }, { model: 'x', input: -1, cached_input: 1, output: 1 }, { model: '__proto__', input: 1, cached_input: 1, output: 1 }, { model: 'x', input: 1, output: 1 }]) {
    assert.equal((await post('/api/admin/prices', bad, developer)).status, 400, JSON.stringify(bad));
  }
  // Reset: a read-only member is refused and nothing changes; an editor's reset removes only that override.
  assert.equal((await post('/api/admin/prices', { model: 'stratus', remove: true }, reader)).status, 403);
  assert.deepEqual(rowOf(await (await get('/api/admin/prices', reader)).json() as PricesBody, 'stratus').override, { input: 1000000, cached_input: 100000, output: 4000000 });
  const reset = await (await post('/api/admin/prices', { model: 'stratus', remove: true }, developer)).json() as PricesBody;
  // stratus is in use nowhere else, so its row goes away with the override (as the old Remove did).
  assert.equal(reset.models.some(item => item.model === 'stratus'), false);
  assert.equal(reset.models.some(item => item.model === 'nimbus'), true);
  assert.equal((await post('/api/admin/prices', { model: 'stratus', remove: true }, outsider)).status, 403);

  // Users: the list and one user. Banked resets survive a window reset.
  await limiter.record(USER, 60, Date.now());
  await store.grantResets('global', USER, '5h', 1);
  const listed = await (await get('/api/admin/users?limit=5', developer)).json() as UsersPageView;
  assert.deepEqual(listed.users[0]!.user, { id: USER, displayName: 'Ada L', username: 'ada', avatarUrl: AVATAR });
  assert.deepEqual(listed.users[0]!.windows.map(window => [window.kind, window.spent, window.banked]), [['5h', 60, 1], ['week', 60, 0]]);
  const one = await (await get(`/api/admin/users/one?user=${USER}`, developer)).json() as UserDetailView;
  assert.deepEqual(one.user, { id: USER, displayName: 'Ada L', username: 'ada', avatarUrl: AVATAR });
  assert.deepEqual(one.windows.map(window => [window.kind, window.spent, window.banked]), [['5h', 60, 1], ['week', 60, 0]]);
  assert.equal((await get('/api/admin/users?limit=7', developer)).status, 400);

  // Grant, reset: an editor's grant and reset return the user's detail. An admin reset does not use a banked reset.
  const granted = await post('/api/admin/users/grant', { user: USER, kind: 'week', count: 2 }, developer);
  assert.equal(granted.status, 200);
  assert.equal((await store.userUsage('global', USER)).resets.week, 2);
  const reset5h = await post('/api/admin/users/reset', { user: USER, kind: '5h' }, developer);
  assert.equal(reset5h.status, 200);
  assert.deepEqual((await reset5h.json() as UserDetailView).windows.map(window => [window.kind, window.spent]), [['5h', 0], ['week', 60]]);
  assert.equal((await store.userUsage('global', USER)).resets['5h'], 1, 'an admin reset does not use a banked reset');
  await post('/api/admin/users/reset', { user: USER }, developer);
  assert.deepEqual((await store.userUsage('global', USER)).windows, []);

  // Web transcripts: the team editor can switch a channel, and the value is checked.
  assert.equal((await post('/api/admin/transcripts', { server: SERVER, channel: '300000000000000001', enabled: 'yes' }, developer)).status, 400);
  assert.deepEqual(await (await post('/api/admin/transcripts', { server: SERVER, channel: '300000000000000001', enabled: true }, developer)).json(), { server: SERVER, channel: '300000000000000001', enabled: true });
  assert.equal((await post('/api/admin/system-prompt', { text: 'Be brief.' }, reader)).status, 403);
  assert.deepEqual(await (await post('/api/admin/system-prompt', { text: 'Be brief.' }, developer)).json(), { text: 'Be brief.', default: DEFAULT_INSTRUCTIONS, max: 8000 });
  assert.deepEqual(await (await get('/api/admin/system-prompt', reader)).json(), { text: 'Be brief.', default: DEFAULT_INSTRUCTIONS, max: 8000 });
  assert.deepEqual(await (await get('/api/admin/servers', developer)).json(), { servers: [{ id: SERVER, name: 'Test server', channelCount: 0, transcriptsOn: 0 }], total: 1 });
  assert.deepEqual(await (await get(`/api/admin/servers/channels?server=${SERVER}`, developer)).json(), { server: SERVER, name: 'Test server', channels: [] });
  assert.equal((await get('/api/admin/servers/channels?server=bad', developer)).status, 400);
  assert.equal((await get('/api/admin/servers?limit=51', developer)).status, 400);

  // Losing the role takes effect after the team reload.
  members = [];
  assert.equal((await get('/api/admin/me', developer)).status, 200, 'the cache still holds the old team');
});

test('Sign-in needs a shared server, and old logins stop when the user leaves', async t => {
  let mode: 'member' | 'none' | 'error' = 'member';
  const store = new SQLiteStore();
  const server = createConsole({origin:'http://localhost:3000',host:'127.0.0.1',port:3000,clientId:'id',clientSecret:'secret'}, { sessions: store,
    async canSignIn() { if (mode === 'error') throw new Error('Discord down'); return mode === 'member'; },
    async snapshot(id) { return {user:id}; }, async invoke() { return {}; },
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise<void>(resolve => server.close(()=>resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, originalFetch = globalThis.fetch;
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request, init?:RequestInit) => {
    if (String(url) === 'https://discord.com/api/oauth2/token') return Response.json({access_token:'oauth-secret'});
    if (String(url) === 'https://discord.com/api/users/@me') return Response.json({id:'123456789012345678'});
    return originalFetch(url,init);
  });
  const signIn = async () => {
    const login = await originalFetch(base+'/auth/login',{redirect:'manual'});
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    return originalFetch(base+`/auth/callback?state=${state}&code=x`,{redirect:'manual',headers:{Cookie:`slopbot_state=${state}`}});
  };
  mode = 'none';
  const denied = await signIn();
  assert.equal(denied.status,403);
  assert.match(await denied.text(),/not in any of your Discord servers/);
  assert.ok(!denied.headers.getSetCookie().some(item => item.includes('slopbot_session=') && !item.includes('Max-Age=0')));
  mode = 'error';
  const failed = await signIn();
  assert.equal(failed.status,503);
  assert.match(await failed.text(),/Try again/);
  assert.ok(!failed.headers.getSetCookie().some(item => item.includes('slopbot_session=')));
  mode = 'member';
  const ok = await signIn();
  assert.equal(ok.status,302);
  const cookie = ok.headers.getSetCookie()[0]!.split(';')[0]!;
  assert.equal((await originalFetch(base+'/api/settings',{headers:{Cookie:cookie}})).status,200);
  mode = 'none';
  const gone = await originalFetch(base+'/api/settings',{headers:{Cookie:cookie}});
  assert.equal(gone.status,401);
  assert.match(gone.headers.get('set-cookie')!,/Max-Age=0/);
  mode = 'member';
  assert.equal((await originalFetch(base+'/api/settings',{headers:{Cookie:cookie}})).status,401);
});
