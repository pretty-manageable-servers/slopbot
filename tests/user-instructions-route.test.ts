import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { createConsole, type ConsoleOptions } from '../src/clients/web/web-console.js';
import { INSTRUCTIONS_REJECT_MESSAGES, USER_INSTRUCTIONS_MAX_CHARS, type InstructionsSaveResult, type InstructionsService, type UserInstructions } from '../src/user-instructions.js';

const ALICE = '100000000000000005', BOB = '100000000000000006';
const NOW = 1_800_000_000_000;

/** Keeps the saved text per user. Text that contains "flagged" is rejected as the safety check would. */
function fakeInstructions(): InstructionsService {
  const saved = new Map<string, UserInstructions>();
  return {
    async get(user) { return saved.get(user); },
    async save(user, text): Promise<InstructionsSaveResult> {
      const clean = text.trim();
      if (!clean) { saved.delete(user); return { ok: true, saved: null }; }
      if (clean.length > USER_INSTRUCTIONS_MAX_CHARS) return { ok: false, reason: 'too_long', message: INSTRUCTIONS_REJECT_MESSAGES.too_long };
      if (clean.includes('flagged')) return { ok: false, reason: 'flagged', category: 'jailbreak', message: INSTRUCTIONS_REJECT_MESSAGES.flagged };
      const entry = { text: clean, updated: NOW };
      saved.set(user, entry);
      return { ok: true, saved: entry };
    },
  };
}

/** Starts a console. login(id) signs in as that Discord user and returns the headers for its requests. */
async function consoleFor(t: TestContext, options: Partial<ConsoleOptions> = {}) {
  const store = new SQLiteStore();
  const server = createConsole({ origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, clientId: 'id', clientSecret: 'secret', ...options }, { sessions: store, async canSignIn() { return true; }, async snapshot() { return {}; }, async invoke() { return {}; } });
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

const shape = (text: string | null, updated: number | null) => ({ text, updated, max: USER_INSTRUCTIONS_MAX_CHARS });

test('instructions are read and saved per signed-in user', async t => {
  const { login, get, post } = await consoleFor(t, { instructions: fakeInstructions() });
  const alice = await login(ALICE), bob = await login(BOB);
  assert.deepEqual(await (await get('/api/settings/instructions', alice)).json(), shape(null, null));

  const saved = await post('/api/settings/instructions', { text: 'Be brief.' }, alice);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), shape('Be brief.', NOW));
  assert.deepEqual(await (await get('/api/settings/instructions', alice)).json(), shape('Be brief.', NOW));
  assert.deepEqual(await (await get('/api/settings/instructions', bob)).json(), shape(null, null), 'bob does not see alice text');

  const cleared = await post('/api/settings/instructions', { text: '   ' }, alice);
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), shape(null, null));
  assert.deepEqual(await (await get('/api/settings/instructions', alice)).json(), shape(null, null));
});

test('a rejected save answers 422 with the reason and the category when there is one', async t => {
  const { login, post } = await consoleFor(t, { instructions: fakeInstructions() });
  const alice = await login(ALICE);

  const flagged = await post('/api/settings/instructions', { text: 'flagged text' }, alice);
  assert.equal(flagged.status, 422);
  assert.deepEqual(await flagged.json(), { error: INSTRUCTIONS_REJECT_MESSAGES.flagged, reason: 'flagged', category: 'jailbreak' });

  const long = await post('/api/settings/instructions', { text: 'x'.repeat(USER_INSTRUCTIONS_MAX_CHARS + 1) }, alice);
  assert.equal(long.status, 422);
  assert.deepEqual(await long.json(), { error: INSTRUCTIONS_REJECT_MESSAGES.too_long, reason: 'too_long' }, 'no category key when the service gives none');
});

test('a body that is not text is a 400, and a write without the CSRF token is a 403', async t => {
  const { login, post } = await consoleFor(t, { instructions: fakeInstructions() });
  const alice = await login(ALICE);

  const notText = await post('/api/settings/instructions', { text: 5 }, alice);
  assert.equal(notText.status, 400);
  assert.deepEqual(await notText.json(), { error: 'Send text as a string.' });

  const withoutCsrf = await post('/api/settings/instructions', { text: 'Be brief.' }, { Cookie: alice.Cookie, Origin: alice.Origin });
  assert.equal(withoutCsrf.status, 403);
});

test('without an instructions service both routes answer 404', async t => {
  const { login, get, post } = await consoleFor(t);
  const alice = await login(ALICE);
  assert.equal((await get('/api/settings/instructions', alice)).status, 404);
  assert.equal((await post('/api/settings/instructions', { text: 'Be brief.' }, alice)).status, 404);
});
