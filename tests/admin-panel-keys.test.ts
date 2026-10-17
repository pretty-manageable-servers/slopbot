import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { AdminInputError, AdminPanel, type AdminConfig } from '../src/admin-panel.js';
import { UserLimiter } from '../src/user-limiter.js';
import { MemberDirectory } from '../src/member-directory.js';
import { fakeSource } from './member-fakes.js';
import { WebKeySecrets } from '../src/web-keys.js';
import { DEFAULT_KEY_CAPS, KEY_CAPS_SETTING, KEY_ERRORS_SETTING, usageMonth } from '../src/web-providers.js';
import { GLOBAL_SETTINGS_SCOPE } from '../src/usage-cost.js';

// A fixed base64 encoding of 32 bytes, for the sealing key.
const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const OWNER = '100000000000000007', OTHER = '100000000000000008', EDITOR = '100000000000000001';
const SECRET = 'tvly-test-1234';
const config: AdminConfig = { model: 'nimbus', jevModel: 'cirrus', embeddingModel: 'embed', baseUrl: 'https://models.example.com/v1', modelPrices: {}, fallbackPrice: { input: 1, cached_input: 1, output: 1 }, userLimit5hCostMicros: 100, userLimitWeekCostMicros: 0, userLimitGracePercent: 10 };

function setup(secrets = new WebKeySecrets(KEY)) {
  const store = new SQLiteStore();
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 });
  const panel = new AdminPanel(config, store, limiter, new MemberDirectory(fakeSource({})), undefined, secrets);
  return { store, panel, secrets };
}

test('the key list shows owner, last four and use, and never the secret', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  await panel.addWebKey(OWNER, { provider: 'tavily', label: 'mine', secret: SECRET });
  await panel.addWebKey(OTHER, { provider: 'firecrawl', secret: 'fc-other-5678' });
  await store.reserveProviderCredits('tavily', usageMonth(), 3, 950);
  const [mine] = (await store.listProviderKeys());
  await store.exhaustProviderKey(mine!.id, usageMonth());

  const view = await panel.webKeys(OWNER);
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /secretEncrypted|tvly-test-1234|fc-other-5678|secret/);
  assert.equal(view.enabled, true);
  assert.equal(view.month, usageMonth());
  assert.deepEqual(view.caps, DEFAULT_KEY_CAPS);
  assert.deepEqual(view.keys.map(key => [key.provider, key.label, key.last4, key.owner, key.mine, key.used, key.exhausted]), [
    ['tavily', 'mine', '1234', OWNER, true, 3, true],
    ['firecrawl', '', '5678', OTHER, false, 0, false],
  ]);
  assert.deepEqual(Object.keys(view.keys[0]!).sort(), ['createdAt', 'exhausted', 'id', 'label', 'last4', 'lastError', 'mine', 'owner', 'provider', 'used']);
  assert.deepEqual((await panel.webKeys(OTHER)).keys.map(key => key.mine), [false, true], 'mine is per member');
});

test('adding a key validates the input and stores only a sealed secret', async t => {
  const { store, panel, secrets } = setup(); t.after(() => store.close());
  const refused: [unknown, RegExp][] = [
    [null, /Send a key as an object/],
    ['tavily', /Send a key as an object/],
    [{ provider: 'serper', secret: SECRET }, /Provider must be one of: tavily, firecrawl/],
    [{ secret: SECRET }, /Provider must be one of/],
    [{ provider: 'tavily', label: 5, secret: SECRET }, /label must be text/],
    [{ provider: 'tavily', label: 'x'.repeat(61), secret: SECRET }, /60 characters or fewer/],
    [{ provider: 'tavily' }, /key must be text/],
    [{ provider: 'tavily', secret: 'tvly abc 1234' }, /8 to 200 printable characters/],
    [{ provider: 'tavily', secret: 'short' }, /8 to 200 printable characters/],
    [{ provider: 'tavily', secret: 'x'.repeat(201) }, /8 to 200 printable characters/],
  ];
  for (const [body, message] of refused) {
    await assert.rejects(panel.addWebKey(OWNER, body), (error: unknown) => error instanceof AdminInputError && message.test(error.message), JSON.stringify(body));
  }
  assert.deepEqual(await store.listProviderKeys(), [], 'bad input saves nothing');

  const view = await panel.addWebKey(OWNER, { provider: 'tavily', label: '  work  ', secret: `  ${SECRET}  ` });
  assert.equal(view.keys.length, 1);
  assert.equal(view.keys[0]!.label, 'work');
  assert.equal(view.keys[0]!.last4, '1234');
  assert.doesNotMatch(JSON.stringify(view), /tvly-test/);

  const [row] = await store.listProviderKeys();
  assert.equal(row!.owner, OWNER);
  assert.equal(row!.provider, 'tavily');
  assert.notEqual(row!.secretEncrypted, SECRET);
  assert.doesNotMatch(row!.secretEncrypted, /tvly-test/);
  assert.equal(secrets.open(row!.secretEncrypted, row!.id), SECRET, 'the sealed value opens to the original');
  assert.throws(() => secrets.open(row!.secretEncrypted, 'another-row'), 'the seal is bound to its row');
});

test('each member keeps at most 10 keys per provider', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  for (let i = 0; i < 10; i++) await panel.addWebKey(OWNER, { provider: 'tavily', secret: `tvly-key-${i}-abcdef` });
  await assert.rejects(panel.addWebKey(OWNER, { provider: 'tavily', secret: 'tvly-key-10-abcdef' }), (error: unknown) => error instanceof AdminInputError && /up to 10 tavily keys/.test(error.message));
  assert.equal((await panel.webKeys(OWNER)).keys.filter(key => key.owner === OWNER).length, 10);
  assert.equal((await panel.addWebKey(OTHER, { provider: 'tavily', secret: 'tvly-other-abcdef' })).keys.length, 11, 'another member has her own limit');
  assert.equal((await panel.addWebKey(OWNER, { provider: 'firecrawl', secret: 'fc-owner-abcdef' })).keys.length, 12, 'the limit is per provider');
});

test('a key is removed by its owner or an editor, not by another member', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  const added = await panel.addWebKey(OWNER, { provider: 'tavily', secret: SECRET });
  const id = added.keys[0]!.id;

  await assert.rejects(panel.deleteWebKey(OTHER, false, { id }), (error: unknown) => error instanceof AdminInputError && error.message === 'Only the key owner or a team editor can remove this key.');
  assert.equal((await store.listProviderKeys()).length, 1, 'a refused removal changes nothing');

  assert.deepEqual((await panel.deleteWebKey(OWNER, false, { id })).keys, []);

  const second = (await panel.addWebKey(OWNER, { provider: 'tavily', secret: 'tvly-second-1111' })).keys[0]!.id;
  assert.deepEqual((await panel.deleteWebKey(EDITOR, true, { id: second })).keys, []);

  await assert.rejects(panel.deleteWebKey(OWNER, true, { id: 'no-such-key' }), (error: unknown) => error instanceof AdminInputError && /does not exist/.test(error.message));
  await assert.rejects(panel.deleteWebKey(OWNER, true, { id: 5 }), AdminInputError);
  await assert.rejects(panel.deleteWebKey(OWNER, true, null), AdminInputError);
});

test('key caps are whole numbers from 1 to 100000 and are saved for all servers', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  assert.deepEqual((await panel.webKeys(OWNER)).caps, DEFAULT_KEY_CAPS);

  for (const body of [null, 'x', { tavily: 0 }, { tavily: 100001 }, { firecrawl: 1.5 }, { firecrawl: '5' }, { tavily: null }]) {
    await assert.rejects(panel.saveKeyCaps(body), AdminInputError, JSON.stringify(body));
  }
  assert.equal(store.setting(GLOBAL_SETTINGS_SCOPE, KEY_CAPS_SETTING), undefined, 'bad input saves nothing');

  assert.deepEqual(await panel.saveKeyCaps({ tavily: 300 }), { tavily: 300, firecrawl: DEFAULT_KEY_CAPS.firecrawl });
  assert.deepEqual(store.setting(GLOBAL_SETTINGS_SCOPE, KEY_CAPS_SETTING), { tavily: 300 });
  assert.deepEqual(await panel.saveKeyCaps({ firecrawl: 100000 }), { tavily: 300, firecrawl: 100000 }, 'a cap not sent keeps its value');
  assert.deepEqual((await panel.webKeys(OTHER)).caps, { tavily: 300, firecrawl: 100000 }, 'every member sees the same caps');

  await store.setSetting(GLOBAL_SETTINGS_SCOPE, KEY_CAPS_SETTING, { tavily: 0, firecrawl: 'many' });
  assert.deepEqual((await panel.webKeys(OWNER)).caps, DEFAULT_KEY_CAPS, 'a bad saved value falls back to the default');
});

test('reset is for editors and clears the last error of one key', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  await panel.addWebKey(OWNER, { provider: 'tavily', label: 'a', secret: SECRET });
  await panel.addWebKey(OWNER, { provider: 'tavily', label: 'b', secret: 'tvly-second-1111' });
  const ids = Object.fromEntries((await panel.webKeys(OWNER)).keys.map(key => [key.label, key.id]));
  const error = { at: 1_800_000_000_000, status: '432', message: 'Plan limit reached', exhausted: true };
  await store.setSetting(GLOBAL_SETTINGS_SCOPE, KEY_ERRORS_SETTING, { [ids.a!]: error, [ids.b!]: { ...error, status: 'timeout', exhausted: false } });
  await store.exhaustProviderKey(ids.a!, usageMonth());

  await assert.rejects(panel.resetWebKey(OWNER, false, { id: ids.a }), (error: unknown) => error instanceof AdminInputError && error.message === 'Only a team editor can reset a key.');
  await assert.rejects(panel.resetWebKey(OTHER, false, { id: ids.a }), AdminInputError);
  await assert.rejects(panel.resetWebKey(EDITOR, true, { id: 'no-such-key' }), (error: unknown) => error instanceof AdminInputError && /does not exist/.test(error.message));
  await assert.rejects(panel.resetWebKey(EDITOR, true, { id: 5 }), AdminInputError);
  await assert.rejects(panel.resetWebKey(EDITOR, true, null), AdminInputError);
  assert.equal((await panel.webKeys(OWNER)).keys.find(key => key.label === 'a')?.lastError?.status, '432', 'a refused reset changes nothing');

  // The store here has no resetProviderKey, so the reset still clears the error and leaves the exhausted flag.
  const view = await panel.resetWebKey(EDITOR, true, { id: ids.a });
  assert.deepEqual(Object.fromEntries(view.keys.map(key => [key.label, key.lastError])), { a: null, b: { ...error, status: 'timeout', exhausted: false } }, 'only the reset key loses its error');

});
