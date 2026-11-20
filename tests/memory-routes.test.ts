import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { createConsole } from '../src/clients/web/web-console.js';
import { memoryRoutes } from '../src/clients/web/routes/memories.js';
import type { Knowledge, MemoryRecord } from '../src/memory.js';
import { PERSONAL_SERVER, personalMemoryChannel } from '../src/personal.js';
import { PROJECT_MEMORY_SERVER, projectMemoryChannel } from '../src/projects.js';

const ALICE = '1514413259522838529', BOB = '1514413259522838530';
const ORIGIN = 'http://localhost:3000';

function memory(id: string, author: string, content: string, scope: 'personal' | 'project'): MemoryRecord {
  const server = scope === 'personal' ? PERSONAL_SERVER : PROJECT_MEMORY_SERVER;
  const channel = scope === 'personal' ? personalMemoryChannel(author) : projectMemoryChannel('p1');
  return { id, server, channel, author, content, sourceIds: [], status: 'active', category: 'fact', tags: [], details: {}, sourcePolicy: 'independent', revision: 1, updatedAt: 5 };
}

/** Memories in memory, with the Knowledge rules the routes rely on: a user sees only their own active memories. */
function fakeKnowledge(memories: MemoryRecord[]): Knowledge {
  const own = (user: string) => memories.filter(item => item.author === user && item.status === 'active');
  return {
    async remember() { throw new Error('not used'); },
    async memories() { throw new Error('not used'); },
    async searchMemories() { throw new Error('not used'); },
    async updateMemory() { throw new Error('not used'); },
    async forget() { throw new Error('not used'); },
    async userMemories(user, query) {
      const text = query.query?.toLowerCase();
      const items = own(user).filter(item => !text || item.content.toLowerCase().includes(text));
      return { items: items.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50)), total: items.length };
    },
    async forgetOwn(user, id) {
      const found = own(user).find(item => item.id === id);
      if (found) found.status = 'forgotten';
      return found !== undefined;
    },
  };
}

/** A console with the memory routes over the fake knowledge. Each user has a session. */
async function setup(t: TestContext, memories: MemoryRecord[]) {
  const sessions = new SQLiteStore(':memory:');
  t.after(() => sessions.close());
  const logins: Record<string, { cookie: string; csrf: string }> = {};
  for (const user of [ALICE, BOB]) {
    const id = randomBytes(32).toString('hex'), csrf = `csrf-${user}`;
    await sessions.saveSession({ id_hash: createHash('sha256').update(id).digest('hex'), user_id: user, csrf, expires: Date.now() + 86_400_000, created: Date.now() });
    logins[user] = { cookie: `slopbot_session=${id}`, csrf };
  }
  const backend = { sessions, async canSignIn() { return true; }, async snapshot() { return {}; }, async invoke() { return {}; }, memories: memoryRoutes(fakeKnowledge(memories)) };
  const web = createConsole({ origin: ORIGIN, host: '127.0.0.1', port: 3000, clientId: 'id', clientSecret: 'secret' }, backend);
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  t.after(() => new Promise<void>(resolve => { web.closeAllConnections(); web.close(() => resolve()); }));
  const address = web.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;

  /** Sends a request as the user (null: no session). Writes carry the origin and CSRF token. */
  async function call(user: string | null, method: string, path: string) {
    const head: Record<string, string> = {};
    if (user) head.Cookie = logins[user]!.cookie;
    if (method !== 'GET') { head.Origin = ORIGIN; if (user) head['X-CSRF-Token'] = logins[user]!.csrf; }
    const response = await fetch(base + path, { method, headers: head, redirect: 'manual' });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  }
  return { call, base, cookie: (user: string) => logins[user]!.cookie };
}

test('list needs a session', async t => {
  const { call } = await setup(t, []);
  assert.equal((await call(null, 'GET', '/api/memories')).status, 401);
});

test('list returns only the signed-in user memories, with their scope', async t => {
  const { call } = await setup(t, [
    memory('m1', ALICE, 'Alice likes green tea.', 'personal'),
    memory('m2', ALICE, 'The thesis uses survey data.', 'project'),
    memory('m3', BOB, 'Bob likes coffee.', 'personal'),
  ]);
  const alice = await call(ALICE, 'GET', '/api/memories');
  assert.equal(alice.status, 200);
  assert.equal(alice.json.total, 2);
  assert.deepEqual(alice.json.items.map((item: { id: string; scope: string }) => [item.id, item.scope]), [['m1', 'personal'], ['m2', 'project:p1']]);
  assert.deepEqual(Object.keys(alice.json.items[0]).sort(), ['category', 'content', 'id', 'scope', 'tags', 'updated']);
  const bob = await call(BOB, 'GET', '/api/memories');
  assert.deepEqual(bob.json.items.map((item: { id: string }) => item.id), ['m3']);
});

test('search narrows the list, and a bad limit is a 400', async t => {
  const { call } = await setup(t, [
    memory('m1', ALICE, 'Alice likes green tea.', 'personal'),
    memory('m2', ALICE, 'The thesis uses survey data.', 'project'),
  ]);
  const found = await call(ALICE, 'GET', '/api/memories?query=TEA');
  assert.deepEqual(found.json, { items: [{ id: 'm1', content: 'Alice likes green tea.', category: 'fact', tags: [], scope: 'personal', updated: 5 }], total: 1 });
  assert.equal((await call(ALICE, 'GET', '/api/memories?limit=500')).status, 400);
});

test('delete 204 then 404, and the memory leaves the list', async t => {
  const { call } = await setup(t, [memory('m1', ALICE, 'Alice likes green tea.', 'personal')]);
  assert.equal((await call(ALICE, 'DELETE', '/api/memories/m1')).status, 204);
  const again = await call(ALICE, 'DELETE', '/api/memories/m1');
  assert.equal(again.status, 404);
  assert.deepEqual(again.json, { error: 'Memory not found.' });
  assert.equal((await call(ALICE, 'GET', '/api/memories')).json.total, 0);
});

test("delete of another user's memory is 404, and the memory stays", async t => {
  const { call } = await setup(t, [memory('m1', ALICE, 'Alice likes green tea.', 'personal')]);
  assert.equal((await call(BOB, 'DELETE', '/api/memories/m1')).status, 404);
  assert.equal((await call(ALICE, 'GET', '/api/memories')).json.total, 1);
});

test('delete needs the same origin and the CSRF token', async t => {
  const { base, cookie } = await setup(t, [memory('m1', ALICE, 'Alice likes green tea.', 'personal')]);
  const headers = { Cookie: cookie(ALICE) };
  assert.equal((await fetch(`${base}/api/memories/m1`, { method: 'DELETE', headers })).status, 403, 'no origin');
  assert.equal((await fetch(`${base}/api/memories/m1`, { method: 'DELETE', headers: { ...headers, Origin: ORIGIN, 'X-CSRF-Token': 'wrong' } })).status, 403, 'wrong CSRF token');
});
