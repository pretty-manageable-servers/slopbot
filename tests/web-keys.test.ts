import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { PostgresStore } from '../src/adapters/postgres.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { newProviderKeyRow, WebKeySecrets } from '../src/web-keys.js';
import type { ProviderKeyRow } from '../src/web-providers.js';

const MONTH = '2026-10';
const secrets = () => new WebKeySecrets(randomBytes(32).toString('base64'));
const SECRET_A = 'tvly-aaaa-1111';
const SECRET_B = 'tvly-bbbb-2222';

function keyRow(s: WebKeySecrets, secret: string, label: string, createdAt: number, provider = 'tavily'): ProviderKeyRow {
  return newProviderKeyRow(s, provider, 'admin', label, secret, createdAt);
}

test('reserve respects the monthly cap and returns undefined when full', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const s = secrets();
  const a = keyRow(s, SECRET_A, 'only', 1);
  await store.addProviderKey(a);
  assert.equal((await store.reserveProviderCredits('tavily', MONTH, 2, 3))?.id, a.id);
  assert.equal(await store.reserveProviderCredits('tavily', MONTH, 2, 3), undefined);
  assert.equal((await store.reserveProviderCredits('tavily', MONTH, 1, 3))?.id, a.id);
  assert.equal(await store.reserveProviderCredits('tavily', MONTH, 1, 3), undefined);
  assert.equal(await store.reserveProviderCredits('firecrawl', MONTH, 1, 3), undefined, 'other providers never match');
});

test('reserve skips exhausted keys even when they have the least used', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const s = secrets();
  const a = keyRow(s, SECRET_A, 'first', 1), b = keyRow(s, SECRET_B, 'second', 2);
  await store.addProviderKey(a); await store.addProviderKey(b);
  await store.exhaustProviderKey(a.id, MONTH);
  assert.equal((await store.reserveProviderCredits('tavily', MONTH, 1, 950))?.id, b.id);
  await store.exhaustProviderKey(b.id, MONTH);
  assert.equal(await store.reserveProviderCredits('tavily', MONTH, 1, 950), undefined);
  assert.deepEqual((await store.providerKeyUsage(MONTH)).map(row => row.exhausted), [true, true]);
});

test('concurrent reserves never pass the cap', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const s = secrets();
  await store.addProviderKey(keyRow(s, SECRET_A, 'only', 1));
  const results = await Promise.all(Array.from({ length: 5 }, () => store.reserveProviderCredits('tavily', MONTH, 1, 2)));
  assert.equal(results.filter(Boolean).length, 2);
});

test('seal and open round trip, and the row id is required as AAD', () => {
  const s = secrets();
  const sealed = s.seal(SECRET_A, 'row-1');
  assert.equal(s.open(sealed, 'row-1'), SECRET_A);
  assert.notEqual(sealed, SECRET_A);
  assert.throws(() => s.open(sealed, 'row-2'));
  const tampered = Buffer.from(sealed, 'base64'); tampered[tampered.length - 1]! ^= 1;
  assert.throws(() => s.open(tampered.toString('base64'), 'row-1'));
});

test('newProviderKeyRow validates provider, secret, label and owner', () => {
  const s = secrets();
  const row = newProviderKeyRow(s, 'firecrawl', 'admin', 'x'.repeat(60), 'fc-secret-9876', 5);
  assert.match(row.id, /^[0-9a-f]{16}$/);
  assert.equal(row.provider, 'firecrawl');
  assert.equal(row.last4, '9876');
  assert.equal(row.createdAt, 5);
  assert.equal(s.open(row.secretEncrypted, row.id), 'fc-secret-9876');
  assert.equal(newProviderKeyRow(s, 'tavily', 'admin', '', SECRET_A, 1).label, '');
  assert.throws(() => newProviderKeyRow(s, 'searxng', 'admin', 'l', SECRET_A, 1), /Provider must be one of/);
  assert.throws(() => newProviderKeyRow(s, 'tavily', 'admin', 'l', 'short', 1), /8 to 200/);
  assert.throws(() => newProviderKeyRow(s, 'tavily', 'admin', 'l', 'has space here', 1), /8 to 200/);
  assert.throws(() => newProviderKeyRow(s, 'tavily', 'admin', 'l', 'x'.repeat(201), 1), /8 to 200/);
  assert.throws(() => newProviderKeyRow(s, 'tavily', 'admin', 'x'.repeat(61), SECRET_A, 1), /60 characters/);
  assert.throws(() => newProviderKeyRow(s, 'tavily', '', 'l', SECRET_A, 1), /owner/);
  assert.throws(() => newProviderKeyRow(new WebKeySecrets(''), 'tavily', 'admin', 'l', SECRET_A, 1), /WEB_KEYS_SECRET/);
});

test('Postgres reserve holds the cap across two connections', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const url = process.env.TEST_DATABASE_URL!;
  const schema = 'slopbot_test_web_keys_' + Date.now().toString(36);
  const first = await PostgresStore.connect(url, undefined, schema);
  const second = await PostgresStore.connect(url, undefined, schema);
  try {
    const s = secrets();
    const a = keyRow(s, SECRET_A, 'only', 1);
    await first.addProviderKey(a);
    const results = await Promise.all([
      first.reserveProviderCredits('tavily', MONTH, 1, 2),
      second.reserveProviderCredits('tavily', MONTH, 1, 2),
      first.reserveProviderCredits('tavily', MONTH, 1, 2),
      second.reserveProviderCredits('tavily', MONTH, 1, 2),
    ]);
    assert.equal(results.filter(Boolean).length, 2);
    assert.deepEqual(await first.providerKeyUsage(MONTH), [{ keyId: a.id, month: MONTH, used: 2, exhausted: false }]);
    assert.equal(await first.deleteProviderKey(a.id), true);
    assert.deepEqual(await second.providerKeyUsage(MONTH), []);
  } finally {
    await first.close(); await second.close();
    const cleanup = new Client({ connectionString: url }); await cleanup.connect();
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await cleanup.end();
  }
});
