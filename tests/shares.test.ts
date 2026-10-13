import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { parseMessage, type Message } from '../src/domain.js';
import { webTranscriptKey } from '../src/server-tools.js';
import { ShareError, ShareService, buildMessages, canCreateShare, isShareId, isShareWrite, renderSharePage, scrubText, toolLine } from '../src/shares.js';
import { createConsole } from '../src/web-console.js';
import { TeamAdmins } from '../src/team-admins.js';

const server = '1528063444874432734', channel = '1528063444874432735';
const admin = '151441325952283852', ada = '151441325952283850', mention = '151441325952283853', bot = '151441325952283854';
const human = '1528063444874432801', answer = '1528063444874432802', later = '1528063444874432803', attachmentUrl = 'https://cdn.discordapp.com/attachments/1528063444874432790/1528063444874432791/private.png';
const secretArgument = 'SECRET-ARGUMENT-7731', costMarker = '0.424242';

interface Fixture { store: SQLiteStore; service: ShareService; clock: { now: number } }

/** A store with one question, one Slopbot answer that used a tool, and a later message. */
async function fixture(options: { managers?: string[]; teamAdmins?: string[]; teams?: TeamAdmins; view?: boolean; switchOn?: boolean } = {}): Promise<Fixture> {
  const store = new SQLiteStore(':memory:');
  const clock = { now: 5000 };
  if (options.switchOn !== false) store.setSetting(server, webTranscriptKey(channel), true);
  const question: Message = parseMessage({
    id: human, server, channel, author: ada, authorName: 'Ada <Lovelace>', text: `hello <@${mention}> mail ada@example.com id ${bot}`,
    timestamp: 1000, attachments: [{ name: 'private.png', url: attachmentUrl, contentType: 'image/png' }],
  });
  await store.ingest(question);
  await store.startRun('run-1', question, { prefixVersion: 'test', prefix: [], history: [], inputs: [], purpose: 'reply' });
  await store.appendEvents('run-1', 0, [
    { kind: 'tool_call', payload: [{ id: 'call-1', name: 'web_search', arguments: { query: secretArgument } }] },
    { kind: 'reasoning', payload: { reasoning_content: 'Reasoning about the question' } },
    { kind: 'usage', payload: { cost: costMarker, model: 'test' } },
    { kind: 'text', payload: { text: 'Answer text' } },
  ]);
  await store.complete('run-1', undefined, [], 'Answer text');
  await store.ingest(parseMessage({ id: answer, server, channel, author: bot, authorName: 'Slopbot', isBot: true, replyTo: human, text: 'Answer text', timestamp: 2000 }));
  await store.ingest(parseMessage({ id: later, server, channel, author: ada, authorName: 'Ada <Lovelace>', text: 'later secret message', timestamp: 3000 }));
  const service = new ShareService({
    store,
    access: { async check() { return { view: options.view ?? true }; } },
    rule: { manager: async user => (options.managers ?? [admin]).includes(user), ...(options.teamAdmins ? { teamAdmin: async (user: string) => options.teamAdmins!.includes(user) } : {}), ...(options.teams ? { teamAdmin: (user: string) => options.teams!.canEdit(user) } : {}) },
    now: () => clock.now,
  });
  return { store, service, clock };
}

test('only Manage Server users, or a team admin when the hook says so, pass the one share rule', async () => {
  const rule = { manager: async (user: string) => user === admin };
  assert.equal(await canCreateShare(admin, server, rule), true);
  assert.equal(await canCreateShare(ada, server, rule), false);
  assert.equal(await canCreateShare(ada, server, { ...rule, teamAdmin: async user => user === ada }), true);
  assert.equal(await canCreateShare(ada, server, { ...rule, teamAdmin: async () => false }), false);
});

test('a non-manager gets 403 for create, list, revoke and revoke-all', async () => {
  const { service } = await fixture();
  const input = { server, channel };
  await assert.rejects(service.create(ada, input), (error: unknown) => error instanceof ShareError && error.status === 403);
  const { id } = await service.create(admin, input);
  await assert.rejects(service.list(ada, server), (error: unknown) => error instanceof ShareError && error.status === 403);
  await assert.rejects(service.revoke(ada, id), (error: unknown) => error instanceof ShareError && error.status === 403);
  await assert.rejects(service.revokeAll(ada, server), (error: unknown) => error instanceof ShareError && error.status === 403);
  assert.ok(await service.snapshot(id), 'the failed revoke must leave the link live');
});

test('a team admin can create and revoke when the hook says so', async () => {
  const { service } = await fixture({ managers: [], teamAdmins: [ada] });
  const { id } = await service.create(ada, { server, channel });
  assert.equal((await service.list(ada, server)).shares.length, 1);
  await service.revoke(ada, id);
  assert.equal(await service.snapshot(id), undefined);
});

test('team editors share through TeamAdmins.canEdit, and team readers get 403', async () => {
  const EDITOR = '151441325952283860', READER = '151441325952283861';
  const teams = new TeamAdmins({ async load() { return { ownerId: admin, members: [{ id: EDITOR, role: 'developer', accepted: true }, { id: READER, role: 'read_only', accepted: true }] }; } });
  const { service } = await fixture({ managers: [], teams });
  const { id } = await service.create(EDITOR, { server, channel });
  assert.equal(isShareId(id), true);
  await assert.rejects(service.create(READER, { server, channel }), (error: unknown) => error instanceof ShareError && error.status === 403);
  await service.revoke(EDITOR, id);
  assert.equal(await service.snapshot(id), undefined);
});

test('create needs channel view and the web transcript switch', async () => {
  const hidden = await fixture({ view: false });
  await assert.rejects(hidden.service.create(admin, { server, channel }), (error: unknown) => error instanceof ShareError && error.status === 403);
  const off = await fixture({ switchOn: false });
  await assert.rejects(off.service.create(admin, { server, channel }), (error: unknown) => error instanceof ShareError && error.status === 403);
});

test('snapshot keeps text and tool labels, and leaves out user IDs, cost, tool results, attachments and later messages', async () => {
  const { service, clock } = await fixture();
  const { id } = await service.create(admin, { server, channel, to: answer });
  clock.now = 9000;
  const snapshot = await service.snapshot(id);
  assert.ok(snapshot);
  const text = JSON.stringify(snapshot);
  for (const forbidden of [ada, admin, bot, mention, secretArgument, costMarker, attachmentUrl, 'private.png', 'later secret message', 'ada@example.com', 'cost', 'usage']) {
    assert.equal(text.includes(forbidden), false, `snapshot must not contain ${forbidden}`);
  }
  assert.deepEqual(snapshot.messages.map(message => message.text), [
    'hello @member mail [email] id [id]', 'Answer text',
  ]);
  assert.deepEqual(snapshot.messages[0]!.attachments, 1);
  assert.deepEqual(snapshot.messages[1]!.tools, [{ name: 'web_search', status: 'Searched the web' }]);
  assert.equal(snapshot.messages[1]!.thinking, undefined);
  assert.equal(snapshot.created_at, 5000);
});

test('messages after creation are not added to a live link', async () => {
  const { service, store } = await fixture();
  const { id } = await service.create(admin, { server, channel });
  await store.ingest(parseMessage({ id: '1528063444874432804', server, channel, author: ada, authorName: 'Ada', text: 'added afterwards', timestamp: 4000 }));
  const page = await service.page(id);
  assert.ok(page);
  assert.equal(page.includes('added afterwards'), false);
  assert.equal(page.includes('later secret message'), true, 'the snapshot holds what was in range at creation');
});

test('a range is inclusive and capped; an empty range is refused', async () => {
  const { service } = await fixture();
  const { id } = await service.create(admin, { server, channel, from: human, to: answer });
  assert.deepEqual((await service.snapshot(id))!.messages.map(message => message.bot), [false, true]);
  await assert.rejects(service.create(admin, { server, channel, from: later, to: human }), /No messages/);
  await assert.rejects(service.create(admin, { server, channel, to: '1528063444874432999' }), /No messages/);
});

test('thinking appears only when asked for', async () => {
  const { service } = await fixture();
  const plain = await service.create(admin, { server, channel, to: answer });
  const thinking = await service.create(admin, { server, channel, to: answer, show_thinking: true, show_avatars: true });
  assert.equal(JSON.stringify(await service.snapshot(plain.id)).includes('Reasoning about the question'), false);
  const shown = await service.snapshot(thinking.id);
  assert.equal(shown!.messages[1]!.thinking, 'Reasoning about the question');
  assert.deepEqual(shown!.options, { show_avatars: true, show_thinking: true });
  assert.deepEqual((await service.snapshot(plain.id))!.options, { show_avatars: false, show_thinking: false });
});

test('a revoked link returns nothing, and revoke-all removes every link in the server', async () => {
  const { service } = await fixture();
  const one = await service.create(admin, { server, channel });
  const two = await service.create(admin, { server, channel });
  assert.ok(await service.page(one.id));
  assert.deepEqual(await service.revoke(admin, one.id), { id: one.id, revoked: true });
  assert.equal(await service.snapshot(one.id), undefined);
  assert.equal(await service.page(one.id), undefined);
  assert.ok(await service.snapshot(two.id));
  assert.deepEqual(await service.revokeAll(admin, server), { revoked: 1 });
  assert.equal(await service.snapshot(two.id), undefined);
  const list = await service.list(admin, server);
  assert.equal(list.shares.length, 2);
  assert.ok(list.shares.every(share => share.revoked));
  await assert.rejects(service.revoke(admin, 'x'.repeat(22)), (error: unknown) => error instanceof ShareError && error.status === 404);
});

test('link IDs are 128 random bits in base64url', async () => {
  const { service } = await fixture();
  const ids = new Set<string>();
  for (let index = 0; index < 40; index++) {
    const { id } = await service.create(admin, { server, channel });
    assert.match(id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(id, 'base64url').length, 16);
    assert.equal(isShareId(id), true);
    ids.add(id);
  }
  assert.equal(ids.size, 40);
  assert.equal(isShareId('short'), false);
  assert.equal(isShareWrite('/api/shares/revoke-all'), true);
  assert.equal(isShareWrite('/api/shares/abc/revoke'), false);
});

test('the page is noindex and escapes message text and names', async () => {
  const store = new SQLiteStore(':memory:');
  store.setSetting(server, webTranscriptKey(channel), true);
  await store.ingest(parseMessage({ id: human, server, channel, author: ada, authorName: '<b>Mallory</b>', text: '<img src=x onerror=alert(1)> "quoted" & \'single\'', timestamp: 1 }));
  const service = new ShareService({ store, access: { async check() { return { view: true }; } }, rule: { manager: async () => true } });
  const { id } = await service.create(admin, { server, channel });
  const page = await service.page(id);
  assert.ok(page);
  assert.match(page, /<meta name="robots" content="noindex">/);
  assert.equal(page.includes('<img src=x'), false);
  assert.equal(page.includes('<b>Mallory</b>'), false);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot; &amp; &#39;single&#39;/);
  assert.match(page, /&lt;b&gt;Mallory&lt;\/b&gt;/);
});

test('renderSharePage keeps an unsafe tool name and status text as text', () => {
  const html = renderSharePage({ id: 'x', created_at: 1, options: { show_avatars: false, show_thinking: false }, messages: [{ author: 'A', bot: true, text: 'hi\n<i>x</i>', attachments: 2, tools: [toolLine('<script>bad()</script>')] }] });
  assert.equal(html.includes('<script>bad()'), false);
  assert.match(html, /\[attachment\] \[attachment\]/);
  assert.match(html, /hi<br>&lt;i&gt;x&lt;\/i&gt;/);
});

test('scrubText removes mentions, emails and long numeric IDs', () => {
  assert.equal(scrubText('<@123456789012345678> <@!123456789012345679> <@&123456789012345680> <#123456789012345681>'), '@member @member @role #channel');
  assert.equal(scrubText('write to a.b+c@mail.example.org or 12345678901234567890 now'), 'write to [email] or [id] now');
});

test('buildMessages gives tool lines and thinking only to the first answer of a request', () => {
  const question = parseMessage({ id: human, server, channel, author: ada, authorName: 'Ada', text: 'q', timestamp: 1 });
  const first = parseMessage({ id: answer, server, channel, author: bot, authorName: 'Slopbot', isBot: true, replyTo: human, text: 'a', timestamp: 2 });
  const second = parseMessage({ id: later, server, channel, author: bot, authorName: 'Slopbot', isBot: true, replyTo: human, text: 'b', timestamp: 3 });
  const rows = buildMessages([question, first, second], [
    { request: human, kind: 'tool_call', payload: [{ id: 'c', name: 'file_read', arguments: { path: 'x' } }] },
    { request: human, kind: 'reasoning', payload: { reasoning: 'why' } },
  ], { show_thinking: true });
  assert.deepEqual(rows[1]!.tools, [{ name: 'file_read', status: 'Read a file' }]);
  assert.equal(rows[1]!.thinking, 'why');
  assert.deepEqual(rows[2]!.tools, []);
  assert.equal(rows[2]!.thinking, undefined);
});

/** Signs in as user through the mocked Discord OAuth. Returns the session cookie and CSRF token. */
async function login(call: (path: string, init?: RequestInit) => Promise<Response>, setUser: (id: string) => void, user: string): Promise<{ cookie: string; csrf: string }> {
  setUser(user);
  const started = await call('/auth/login', { redirect: 'manual' });
  const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
  const callback = await call(`/auth/callback?state=${state}&code=x`, { redirect: 'manual', headers: { Cookie: `slopbot_state=${state}` } });
  const cookie = callback.headers.getSetCookie()[0]!.split(';')[0]!;
  const settings = await (await call('/api/settings', { headers: { Cookie: cookie } })).json() as { csrf: string };
  return { cookie, csrf: settings.csrf };
}

test('HTTP routes: public page and JSON, noindex headers, manager-only writes with CSRF', async t => {
  const { service } = await fixture();
  const web = createConsole({ origin: 'http://localhost:3000', host: '127.0.0.1', port: 0, clientId: 'id', clientSecret: 'secret' }, { sessions: new SQLiteStore(),
    async snapshot(id) { return { user: id }; },
    async invoke() { return {}; },
    shares: service,
  });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  t.after(() => new Promise<void>(resolve => web.close(() => resolve())));
  const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const originalFetch = globalThis.fetch;
  let who = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://discord.com/api/oauth2/token') return Response.json({ access_token: 'token' });
    if (String(url) === 'https://discord.com/api/users/@me') return Response.json({ id: who });
    return originalFetch(url, init);
  });
  const call = (path: string, init?: RequestInit) => originalFetch(base + path, init);

  const outsider = await login(call, value => { who = value; }, ada);
  const manager = await login(call, value => { who = value; }, admin);
  const body = JSON.stringify({ server, channel });
  const writeHeaders = (session: { cookie: string; csrf: string }) => ({ Cookie: session.cookie, 'Content-Type': 'application/json', Origin: 'http://localhost:3000', 'X-CSRF-Token': session.csrf });

  assert.equal((await call('/api/shares', { method: 'POST', headers: writeHeaders(outsider), body })).status, 403);
  assert.equal((await call('/api/shares', { method: 'POST', headers: { ...writeHeaders(manager), Origin: 'https://evil.example' }, body })).status, 403);
  const created = await call('/api/shares', { method: 'POST', headers: writeHeaders(manager), body });
  assert.equal(created.status, 200);
  const { id } = await created.json() as { id: string };

  const page = await call(`/s/${id}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const html = await page.text();
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.equal(html.includes(ada), false);

  const json = await call(`/api/shares/${id}`);
  assert.equal(json.status, 200);
  assert.equal(json.headers.get('x-robots-tag'), 'noindex');
  assert.equal((await json.text()).includes(ada), false);

  const listed = await call(`/api/shares?server=${server}`, { headers: { Cookie: outsider.cookie } });
  assert.equal(listed.status, 403);
  const shown = await call(`/api/shares?server=${server}`, { headers: { Cookie: manager.cookie } });
  assert.equal(((await shown.json()) as { shares: unknown[] }).shares.length, 1);

  assert.equal((await call(`/api/shares/${id}/revoke`, { method: 'POST', headers: writeHeaders(outsider), body: '{}' })).status, 403);
  assert.equal((await call(`/api/shares/${id}/revoke`, { method: 'POST', headers: writeHeaders(manager), body: '{}' })).status, 200);
  assert.equal((await call(`/s/${id}`)).status, 404);
  assert.equal((await call(`/api/shares/${id}`)).status, 404);
  assert.equal((await call('/s/not-a-real-share-id-here')).status, 404);
  assert.equal((await call(`/api/shares/${id}/revoke`, { method: 'POST', headers: writeHeaders(manager), body: '{}' })).status, 200);
  assert.equal((await call('/api/shares/revoke-all', { method: 'POST', headers: writeHeaders(outsider), body })).status, 403);
  assert.deepEqual(await (await call('/api/shares/revoke-all', { method: 'POST', headers: writeHeaders(manager), body })).json(), { revoked: 0 });
});
