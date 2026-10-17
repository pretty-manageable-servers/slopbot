import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelAliases } from '../src/adapters/model-aliases.js';
const rejected = () => Response.json({ error: { code: 'model_not_allowed' } }, { status: 403 });
test('known gateway aliases fall back, cache success and recover when legacy IDs retire', async () => {
  const aliases = new ModelAliases('https://api.pmservers.org/ai/v1');
  const calls: string[] = [];
  const send = async (model: string) => { calls.push(model); return model === 'stratus' ? rejected() : Response.json({ ok: true }); };
  assert.equal((await aliases.request('stratus', send)).status, 200);
  assert.equal((await aliases.request('stratus', send)).status, 200);
  assert.deepEqual(calls, ['stratus', 'embeddinggemma2', 'embeddinggemma2']);
  assert.equal((await aliases.request('stratus', async model => { calls.push(model); return model === 'embeddinggemma2' ? rejected() : Response.json({ ok: true }); })).status, 200);
  assert.deepEqual(calls.slice(-2), ['embeddinggemma2', 'stratus']);
});
test('other providers, unknown models, auth failures and generation failures never retry', async () => {
  for (const [base, model, status, code] of [
    ['https://other.example', 'nimbus', 403, 'model_not_allowed'],
    ['https://api.pmservers.org/ai/v1', 'unknown', 403, 'model_not_allowed'],
    ['https://api.pmservers.org/ai/v1', 'constructor', 403, 'model_not_allowed'],
    ['https://api.pmservers.org/ai/v1', 'nimbus', 401, 'model_not_allowed'],
    ['https://api.pmservers.org/ai/v1', 'nimbus', 403, 'access_denied'],
    ['https://api.pmservers.org/ai/v1', 'nimbus', 500, 'model_not_found'],
  ] as const) {
    let calls = 0;
    await new ModelAliases(base).request(model, async () => { calls++; return Response.json({ error: { code } }, { status }); });
    assert.equal(calls, 1);
  }
});
