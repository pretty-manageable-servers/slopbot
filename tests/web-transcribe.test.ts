import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { handleTranscribe, transcribeLimits, type TranscribeDeps } from '../src/web-transcribe.js';

const ORIGIN = 'http://localhost:3000';
const session = { user: 'u1', csrf: 'tok' };

async function start(deps: Partial<TranscribeDeps>) {
  const full: TranscribeDeps = { audio: { transcribeWav: async () => 'hello' }, origin: ORIGIN, limits: transcribeLimits(), ...deps };
  const server = createServer((req, res) => void handleTranscribe(req, res, session, full));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const post = async (body: Uint8Array, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/transcribe`, { method: 'POST', body: new Blob([new Uint8Array(body)]), headers: { 'Content-Type': 'audio/wav', Origin: ORIGIN, 'X-CSRF-Token': 'tok', ...headers } });
    return { status: response.status, body: await response.json() as { text?: string; error?: string } };
  };
  return { post, close: () => server.close() };
}

test('transcribes a WAV and returns the text', async t => {
  let received = 0;
  const { post, close } = await start({ audio: { transcribeWav: async wav => { received = wav.length; return 'hi there'; } } });
  t.after(close);
  const reply = await post(new Uint8Array(100));
  assert.deepEqual(reply, { status: 200, body: { text: 'hi there' } });
  assert.equal(received, 100);
});

test('rejects audio over 10 MB with 413', async t => {
  const { post, close } = await start({});
  t.after(close);
  assert.equal((await post(new Uint8Array(10 * 1024 * 1024 + 1))).status, 413);
});

test('answers 429 while two requests are running and after 60 in a minute', async t => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = await start({ audio: { transcribeWav: async () => { entered(); await gate; return 'x'; } } });
  t.after(slow.close);
  // The final clip may start while a partial runs: two at once are allowed, a third is not.
  const first = slow.post(new Uint8Array(10));
  await started;
  const second = slow.post(new Uint8Array(10));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await slow.post(new Uint8Array(10))).status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);

  const fast = await start({ now: () => 1000 });
  t.after(fast.close);
  for (let i = 0; i < 60; i++) assert.equal((await fast.post(new Uint8Array(10))).status, 200);
  assert.equal((await fast.post(new Uint8Array(10))).status, 429);
});

test('answers 503 without audio config and 502 on provider errors', async t => {
  const none = await start({ audio: undefined });
  t.after(none.close);
  assert.deepEqual(await none.post(new Uint8Array(10)), { status: 503, body: { error: 'Dictation is not available.' } });
  const broken = await start({ audio: { transcribeWav: async () => { throw new Error('upstream down'); } } });
  t.after(broken.close);
  const reply = await broken.post(new Uint8Array(10));
  assert.equal(reply.status, 502);
  assert.ok(reply.body.error);
});

test('rejects a missing CSRF token or wrong origin', async t => {
  const { post, close } = await start({});
  t.after(close);
  assert.equal((await post(new Uint8Array(10), { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await post(new Uint8Array(10), { Origin: 'http://evil.example' })).status, 403);
});
