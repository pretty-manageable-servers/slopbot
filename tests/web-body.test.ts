import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { Hono } from 'hono';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { createConsole, type ConsoleBackend } from '../src/clients/web/web-console.js';
import type { WebEnv } from '../src/clients/web/env.js';

const USER = '100000000000000001', ORIGIN = 'http://localhost:3000', SESSION = 'cookie-value', CSRF = 'csrf-token';

/** A console with one saved login. `raw` sends a body in the chunks given, so a chunk can end inside a character. */
async function consoleFor(t: TestContext, extra: Partial<ConsoleBackend> = {}) {
  const store = new SQLiteStore(':memory:');
  await store.saveSession({ id_hash: createHash('sha256').update(SESSION).digest('hex'), user_id: USER, csrf: CSRF, expires: Date.now() + 30 * 86_400_000, created: Date.now() });
  const invoked: unknown[] = [];
  const server = createConsole({ origin: ORIGIN, host: '127.0.0.1', port: 3000, clientId: 'id', clientSecret: 'secret' }, {
    sessions: store, async canSignIn() { return true; }, async snapshot() { return {}; },
    async invoke(_user, _server, _channel, _name, args) { invoked.push(args); return {}; },
    async useReset() { return {}; },
    async mcp(_user, _server, input) { return { input }; },
    ...extra,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  t.after(() => store.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const headers = { Cookie: `slopbot_session=${SESSION}`, Origin: ORIGIN, 'X-CSRF-Token': CSRF, 'Content-Type': 'application/json' };
  const post = (path: string, body: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers, body });
  const raw = (path: string, chunks: Buffer[]) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path, method: 'POST', headers }, res => {
      const parts: Buffer[] = []; res.on('data', part => parts.push(part)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject);
    req.setNoDelay(true);
    // Each chunk is written once the one before it has gone out, so the server sees them as separate reads.
    (async () => { for (const chunk of chunks) await new Promise<void>(sent => req.write(chunk, () => sent())); req.end(); })();
  });
  return { post, raw, invoked, address };
}

test('a JSON body split inside a multi-byte character is read whole', async t => {
  const { raw, invoked } = await consoleFor(t);
  const bytes = Buffer.from(JSON.stringify({ channel: '100000000000000002', name: 'profile', args: { action: 'set', text: 'héllo wörld 日本語 🙂' } }));
  const cut = bytes.indexOf(Buffer.from('日')) + 1; // inside the three bytes of the first Japanese character
  const answer = await raw('/api/settings', [bytes.subarray(0, cut), bytes.subarray(cut)]);
  assert.equal(answer.status, 200);
  assert.deepEqual(invoked, [{ action: 'set', text: 'héllo wörld 日本語 🙂' }]);
});

test('a null or non-object body on /api/mcp is a 400, not a server error', async t => {
  const { post } = await consoleFor(t);
  for (const body of ['null', '5', '"text"', '[]']) {
    const answer = await post('/api/mcp', body);
    assert.equal(answer.status, 400, body);
    assert.deepEqual(await answer.json(), { error: 'Invalid request.' });
  }
  assert.equal((await post('/api/mcp', '{"server":"100000000000000002"}')).status, 200);
});

test('a body over the limit is a 413 and invalid JSON a 400', async t => {
  const { post } = await consoleFor(t);
  for (const [path, limit] of [['/api/usage/reset', 1024], ['/api/mcp', 65536], ['/api/settings', 16384]] as const) {
    const answer = await post(path, JSON.stringify({ pad: 'x'.repeat(limit) }));
    assert.equal(answer.status, 413, path);
    assert.deepEqual(await answer.json(), { error: 'Request too large.' });
  }
  const answer = await post('/api/mcp', '{');
  assert.equal(answer.status, 400);
  assert.deepEqual(await answer.json(), { error: 'Invalid JSON.' });
});

test('a route that fails after its response head went out ends the stream and the server keeps serving', async t => {
  const crashing = new Hono<WebEnv>();
  crashing.get('/conversations/boom', c => {
    c.env.outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
    c.env.outgoing.write('retry: 3000\n\n');
    throw new Error('stream failed');
  });
  const { address } = await consoleFor(t, { conversations: crashing });
  const crashed = await fetch(`http://127.0.0.1:${address.port}/api/conversations/boom`, { headers: { Cookie: `slopbot_session=${SESSION}` } });
  assert.equal(crashed.status, 200);
  assert.equal(await crashed.text(), 'retry: 3000\n\n');
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/version`)).status, 200);
});
