import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleOptions, createConsole } from '../src/web-console.js';
import { ToolError } from '../src/tools.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { AdminPanel } from '../src/admin-panel.js';
import { TeamAdmins, type TeamSnapshot } from '../src/team-admins.js';
import { UserLimiter } from '../src/user-limiter.js';
import type { ConsoleAdmin } from '../src/web-console.js';
import { MemberDirectory } from '../src/member-directory.js';
import { fakeSource } from './member-fakes.js';

test('web console is opt-in and rejects insecure public origins', () => {
  assert.equal(consoleOptions({}), undefined);
  assert.throws(() => consoleOptions({WEB_ENABLED:'true',WEB_ORIGIN:'http://example.com'}), /HTTPS/);
  assert.throws(() => consoleOptions({WEB_ENABLED:'true',WEB_ORIGIN:'https://slopbot.pmservers.org/console',DISCORD_CLIENT_ID:'id',DISCORD_CLIENT_SECRET:'secret'}), /without a path/);
  assert.throws(() => consoleOptions({WEB_ENABLED:'true'}), /CLIENT_ID/);
});
test('Discord login binds state to browser, protects writes, and destroys logout sessions', async t => {
  let user = '', name = '', deny = false;
  const server = createConsole({origin:'http://localhost:3000',host:'127.0.0.1',port:3000,clientId:'id',clientSecret:'secret'}, { sessions: new SQLiteStore(),
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
  await writeFile(join(dir,'secret.txt'),'secret');
  const server=createConsole({origin:'http://localhost:3000',host:'127.0.0.1',port:3000,clientId:'id',clientSecret:'secret',siteDir:join(dir,'site/out')},{ sessions: new SQLiteStore(),async snapshot(){return {};},async invoke(){return {};}});
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
test('landing returns 404 when site/out is missing',async t=>{
  const server=createConsole({origin:'http://localhost:3000',host:'127.0.0.1',port:3000,clientId:'id',clientSecret:'secret',siteDir:join(tmpdir(),'slopbot-no-such-site')},{async snapshot(){return {};},async invoke(){return {};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base+'/')).status,404);
  assert.equal((await fetch(base+'/console')).status,200);
});
test('team admin routes need team membership, and only editors can change settings', async t => {
  const store = new SQLiteStore(), OWNER = '100000000000000001', DEVELOPER = '100000000000000003', READER = '100000000000000004', OUTSIDER = '100000000000000005', USER = '100000000000000007';
  const SERVER = '200000000000000001';
  let members: TeamSnapshot['members'] = [{ id: DEVELOPER, role: 'developer', accepted: true }, { id: READER, role: 'read_only', accepted: true }];
  const teams = new TeamAdmins({ async load() { return { ownerId: OWNER, members: [...members] }; } });
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 });
  const AVATAR = 'https://cdn.discordapp.com/guilds/1/users/7/avatar.png';
  const directory = new MemberDirectory(fakeSource({ [DEVELOPER]: { username: 'dev', inServer: true }, [READER]: { username: 'reader', inServer: true }, [USER]: { username: 'ada', nickname: 'Ada L', serverAvatar: AVATAR, inServer: true, email: 'ada@example.com' } }));
  const panel = new AdminPanel({ model: 'nimbus', jevModel: 'cirrus', embeddingModel: 'embed', baseUrl: 'https://models.example.com/v1', modelPrices: {}, fallbackPrice: { input: 1, cached_input: 1, output: 1 }, userLimit5hCostMicros: 100, userLimitWeekCostMicros: 0, userLimitGracePercent: 10 }, store, limiter, directory);
  const rotated: string[] = [];
  const admin: ConsoleAdmin = { role: id => teams.role(id), canEdit: id => teams.canEdit(id), servers: async () => ({ servers: [{ id: SERVER, name: 'Test server', channels: [] }] }), setTranscript: async (server, channel, enabled) => ({ server, channel, enabled }), rotateWebhook: async (_server, channel) => { rotated.push(channel); return { webhookId: 'hook-2' }; }, panel };
  const server = createConsole({origin:'http://localhost:3000',host:'127.0.0.1',port:3000,clientId:'id',clientSecret:'secret'}, { sessions: new SQLiteStore(),
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
  const reads = ['/api/admin/me', `/api/admin/limits?server=${SERVER}`, '/api/admin/prices', `/api/admin/usage?server=${SERVER}`, `/api/admin/members?server=${SERVER}&q=ad`, '/api/admin/servers'];
  const writes: [string, unknown][] = [
    ['/api/admin/limits', { server: SERVER, five_hour_cost_micros: 5000000, week_cost_micros: 20000000, grace_percent: 15 }],
    ['/api/admin/prices', { model: 'stratus', input: 1000000, cached_input: 100000, output: 4000000 }],
    ['/api/admin/usage/reset', { server: SERVER, user: USER, kind: '5h' }],
    ['/api/admin/usage/grant', { server: SERVER, user: USER, kind: '5h', count: 1 }],
    ['/api/admin/transcripts', { server: SERVER, channel: '300000000000000001', enabled: true }],
    ['/api/admin/web-webhooks/rotate', { server: SERVER, channel: '300000000000000001' }],
  ];

  // Not a member: every admin route is refused.
  for (const path of reads) assert.equal((await get(path, outsider)).status, 403, path);
  for (const [path, body] of writes) assert.equal((await post(path, body, outsider)).status, 403, path);
  assert.equal((await get('/api/admin/me', {})).status, 401, 'no session is still 401');

  // Read-only member: reads work, writes are refused and change nothing.
  assert.deepEqual(await (await get('/api/admin/me', reader)).json(), { role: 'read_only', canEdit: false });
  for (const path of reads) assert.equal((await get(path, reader)).status, 200, path);
  for (const [path, body] of writes) assert.equal((await post(path, body, reader)).status, 403, path);
  assert.equal(store.setting(SERVER, 'user_limit_5h_cost_micros'), undefined);
  assert.equal((await post('/api/admin/limits', writes[0]![1], { ...reader, 'X-CSRF-Token': 'wrong', Origin: 'https://evil.example' })).status, 403);

  // Developer: reads and writes work.
  assert.deepEqual(await (await get('/api/admin/me', developer)).json(), { role: 'developer', canEdit: true });
  const limits = await post('/api/admin/limits', writes[0]![1], developer);
  assert.equal(limits.status, 200);
  assert.deepEqual(await limits.json(), { server: SERVER, five_hour_cost_micros: 5000000, week_cost_micros: 20000000, grace_percent: 15, defaults: { five_hour_cost_micros: 100, week_cost_micros: 0, grace_percent: 10 } });
  assert.equal(store.setting(SERVER, 'user_limit_week_cost_micros'), 20000000);
  for (const bad of [{ five_hour_cost_micros: -1, week_cost_micros: 0, grace_percent: 0 }, { five_hour_cost_micros: 1.5, week_cost_micros: 0, grace_percent: 0 }, { five_hour_cost_micros: 1, week_cost_micros: 0, grace_percent: 1001 }, { five_hour_cost_micros: 1, week_cost_micros: 'x', grace_percent: 0 }]) {
    assert.equal((await post('/api/admin/limits', { server: SERVER, ...bad }, developer)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post('/api/admin/limits', { server: 'nope', five_hour_cost_micros: 1, week_cost_micros: 0, grace_percent: 0 }, developer)).status, 400);
  assert.equal(store.setting(SERVER, 'user_limit_5h_cost_micros'), 5000000, 'bad input saves nothing');
  assert.equal((await get(`/api/admin/limits?server=${SERVER}`, developer)).status, 200);

  // Rotate: refused members rotate nothing; an editor rotates one channel's webhook and bad input rotates nothing.
  assert.deepEqual(rotated, []);
  const rotate = await post('/api/admin/web-webhooks/rotate', { server: SERVER, channel: '300000000000000001' }, developer);
  assert.equal(rotate.status, 200);
  assert.deepEqual(await rotate.json(), { webhookId: 'hook-2' });
  assert.deepEqual(rotated, ['300000000000000001']);
  assert.equal((await post('/api/admin/web-webhooks/rotate', { server: SERVER, channel: 'bad' }, developer)).status, 400);
  assert.deepEqual(rotated, ['300000000000000001']);

  // Prices: add, read back, remove. The saved table is the only thing that changes.
  const priced = await (await post('/api/admin/prices', writes[1]![1], developer)).json() as { saved_models: string[]; prices: Record<string, unknown>; models: string[] };
  assert.deepEqual(priced.saved_models, ['stratus']);
  assert.deepEqual(priced.prices.stratus, { input: 1000000, cached_input: 100000, output: 4000000 });
  assert.ok(priced.models.includes('nimbus') && priced.models.includes('cirrus') && priced.models.includes('embed') && priced.models.includes('stratus'));
  for (const bad of [{ model: '', input: 1, cached_input: 1, output: 1 }, { model: 'x', input: -1, cached_input: 1, output: 1 }, { model: '__proto__', input: 1, cached_input: 1, output: 1 }, { model: 'x', input: 1, output: 1 }]) {
    assert.equal((await post('/api/admin/prices', bad, developer)).status, 400, JSON.stringify(bad));
  }
  const removed = await (await post('/api/admin/prices', { model: 'stratus', remove: true }, developer)).json() as { saved_models: string[] };
  assert.deepEqual(removed.saved_models, []);

  // Usage: list, one user, grant, reset. Banked resets survive a window reset.
  await limiter.record(SERVER, USER, 60, Date.now());
  await store.grantResets(SERVER, USER, '5h', 1);
  const listed = await (await get(`/api/admin/usage?server=${SERVER}`, developer)).json() as { users: { user: { id: string; displayName: string; username: string | null; avatarUrl: string | null }; windows: { kind: string; spent: number; banked: number }[] }[] };
  assert.deepEqual(listed.users[0]!.user, { id: USER, displayName: 'Ada L', username: 'ada', avatarUrl: AVATAR });
  assert.deepEqual(listed.users[0]!.windows.map(window => [window.kind, window.spent, window.banked]), [['5h', 60, 1], ['week', 60, 0]]);
  assert.equal((await get(`/api/admin/usage?server=${SERVER}&user=bad`, developer)).status, 400);
  const one = await (await get(`/api/admin/usage?server=${SERVER}&user=${USER}`, developer)).json() as { user: unknown; windows: { kind: string; spent: number; banked: number }[] };
  assert.deepEqual(one.user, { id: USER, displayName: 'Ada L', username: 'ada', avatarUrl: AVATAR });
  assert.deepEqual(one.windows.map(window => [window.kind, window.spent, window.banked]), [['5h', 60, 1], ['week', 60, 0]]);

  // Member search: a name finds the member and the answer has no email or raw email data. An empty query finds nobody.
  assert.deepEqual(await (await get(`/api/admin/members?server=${SERVER}&q=%20Ad%20`, developer)).json(), { server: SERVER, members: [{ id: USER, displayName: 'Ada L', username: 'ada', avatarUrl: AVATAR }] });
  assert.deepEqual(await (await get(`/api/admin/members?server=${SERVER}&q=%20%20`, developer)).json(), { server: SERVER, members: [] });
  assert.equal((await get(`/api/admin/members?server=${SERVER}&q=${'a'.repeat(101)}`, developer)).status, 400);
  assert.equal((await get('/api/admin/members?server=bad&q=a', developer)).status, 400);
  assert.doesNotMatch(await (await get(`/api/admin/members?server=${SERVER}&q=ad`, developer)).text(), /email|@example/);
  assert.equal((await get('/api/admin/usage?server=bad', developer)).status, 400);
  const granted = await post('/api/admin/usage/grant', { server: SERVER, user: USER, kind: 'week', count: 2 }, developer);
  assert.equal(granted.status, 200);
  assert.equal((await store.userUsage(SERVER, USER)).resets.week, 2);
  for (const bad of [{ kind: 'week', count: 0 }, { kind: 'week', count: 101 }, { kind: 'month', count: 1 }]) {
    assert.equal((await post('/api/admin/usage/grant', { server: SERVER, user: USER, ...bad }, developer)).status, 400, JSON.stringify(bad));
  }
  const reset5h = await post('/api/admin/usage/reset', { server: SERVER, user: USER, kind: '5h' }, developer);
  assert.equal(reset5h.status, 200);
  assert.deepEqual((await reset5h.json() as { windows: { kind: string; spent: number }[] }).windows.map(window => [window.kind, window.spent]), [['5h', 0], ['week', 60]]);
  assert.equal((await store.userUsage(SERVER, USER)).resets['5h'], 1, 'an admin reset does not use a banked reset');
  await post('/api/admin/usage/reset', { server: SERVER, user: USER }, developer);
  assert.deepEqual((await store.userUsage(SERVER, USER)).windows, []);

  // Web transcripts: the team editor can switch a channel, and the value is checked.
  assert.equal((await post('/api/admin/transcripts', { server: SERVER, channel: '300000000000000001', enabled: 'yes' }, developer)).status, 400);
  assert.deepEqual(await (await post('/api/admin/transcripts', writes[4]![1], developer)).json(), { server: SERVER, channel: '300000000000000001', enabled: true });
  assert.deepEqual(await (await get('/api/admin/servers', developer)).json(), { servers: [{ id: SERVER, name: 'Test server', channels: [] }] });

  // Losing the role takes effect after the team reload.
  members = [];
  assert.equal((await get('/api/admin/me', developer)).status, 200, 'the cache still holds the old team');
});
