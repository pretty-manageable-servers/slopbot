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

test('provider keys can be added, listed and deleted with their usage', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const s = secrets();
  const a = keyRow(s, SECRET_A, 'first', 1), b = keyRow(s, SECRET_B, 'second', 2);
  await store.addProviderKey(a); await store.addProviderKey(b);
  assert.deepEqual((await store.listProviderKeys()).map(row => row.id), [a.id, b.id]);
  assert.equal((await store.listProviderKeys())[0]?.last4, '1111');
  assert.notEqual((await store.listProviderKeys())[0]?.secretEncrypted, SECRET_A);

  assert.equal((await store.reserveProviderCredits('tavily', MONTH, 3, 100))?.id, a.id);
  assert.equal(await store.deleteProviderKey(a.id), true);
  assert.equal(await store.deleteProviderKey(a.id), false);
  assert.deepEqual((await store.listProviderKeys()).map(row => row.id), [b.id]);
  assert.deepEqual(await store.providerKeyUsage(MONTH), []);
});

test('reserve picks the lowest-used key, then the oldest on a tie', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const s = secrets();
  const a = keyRow(s, SECRET_A, 'first', 1), b = keyRow(s, SECRET_B, 'second', 2);
  await store.addProviderKey(a); await store.addProviderKey(b);
  const picks = [];
  for (let i = 0; i < 3; i++) picks.push((await store.reserveProviderCredits('tavily', MONTH, 1, 950))?.id);
  assert.deepEqual(picks, [a.id, b.id, a.id]);
  assert.deepEqual(Object.fromEntries((await store.providerKeyUsage(MONTH)).map(row => [row.keyId, row.used])), { [a.id]: 2, [b.id]: 1 });
});

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

test('usage resets by month and exhaustion applies to one month only', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const s = secrets();
  const a = keyRow(s, SECRET_A, 'only', 1);
  await store.addProviderKey(a);
  assert.equal((await store.reserveProviderCredits('tavily', MONTH, 1, 1))?.id, a.id);
  assert.equal(await store.reserveProviderCredits('tavily', MONTH, 1, 1), undefined);
  assert.equal((await store.reserveProviderCredits('tavily', '2026-11', 1, 1))?.id, a.id);
  await store.exhaustProviderKey(a.id, '2026-12');
  assert.deepEqual(await store.providerKeyUsage('2026-12'), [{ keyId: a.id, month: '2026-12', used: 0, exhausted: true }]);
  assert.deepEqual(await store.providerKeyUsage(MONTH), [{ keyId: a.id, month: MONTH, used: 1, exhausted: false }]);
  assert.equal((await store.reserveProviderCredits('tavily', '2027-01', 1, 1))?.id, a.id);
});

test('reserve rejects credits that are not a positive integer', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await assert.rejects(store.reserveProviderCredits('tavily', MONTH, 0, 10), /positive integer/);
  await assert.rejects(store.reserveProviderCredits('tavily', MONTH, 1.5, 10), /positive integer/);
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

test('seal fails when no key is configured, and a bad key throws', () => {
  // An empty string means unset. Passing undefined would read WEB_KEYS_SECRET from the environment.
  const disabled = new WebKeySecrets('');
  assert.equal(disabled.enabled, false);
  assert.throws(() => disabled.seal(SECRET_A, 'row-1'), /WEB_KEYS_SECRET/);
  assert.throws(() => new WebKeySecrets('not-a-key'), /32-byte/);
  assert.throws(() => new WebKeySecrets(randomBytes(16).toString('base64')), /32-byte/);
  assert.equal(new WebKeySecrets(randomBytes(32).toString('base64')).enabled, true);
});

test('WEB_KEYS_SECRET from the environment is read by default and checked', () => {
  const saved = process.env.WEB_KEYS_SECRET;
  try {
    process.env.WEB_KEYS_SECRET = 'short';
    assert.throws(() => new WebKeySecrets(), /WEB_KEYS_SECRET must be a base64-encoded 32-byte key/);
    process.env.WEB_KEYS_SECRET = randomBytes(32).toString('base64');
    assert.equal(new WebKeySecrets().enabled, true);
  } finally {
    if (saved === undefined) delete process.env.WEB_KEYS_SECRET; else process.env.WEB_KEYS_SECRET = saved;
  }
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
