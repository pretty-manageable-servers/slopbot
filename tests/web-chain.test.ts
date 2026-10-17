import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { FallbackFetch, FallbackSearch, StoreKeyPool } from '../src/web-chain.js';

import { ToolError } from '../src/tools.js';
import { UserLimitError } from '../src/user-limiter.js';
import { GLOBAL_SETTINGS_SCOPE } from '../src/usage-cost.js';
import { DEFAULT_KEY_CAPS, KEY_CAPS_SETTING, ProviderFailed, usageMonth, type KeyedFetch, type KeyedProvider, type KeyedSearch, type PageText, type ProviderKey, type ProviderKeyPool, type ProviderKeyRow, type ProviderKeyStore, type ProviderKeyUsage, type WebCharge, type WebFetch, type WebProvider } from '../src/web-providers.js';
import type { SearchHit, WebSearch, WebUser } from '../src/web-search.js';

const who: WebUser = {server: 's', user: 'u'};
const hit = (name: string): SearchHit => ({title: name, url: `https://${name}.example/`, snippet: name});
const key = (provider: KeyedProvider, id: string): ProviderKey => ({id, provider, secret: `secret-${id}`});
const page = (text: string, truncated = false): PageText => ({url: 'https://page.example/', title: 'Page', text, truncated});

class FakeWebSearch implements WebSearch {
  calls = 0;
  constructor(private readonly answer: () => readonly SearchHit[]) {}
  async search(_query: string, _limit: number): Promise<readonly SearchHit[]> {
    this.calls++;
    return this.answer();
  }
}

class FakeKeyedSearch implements KeyedSearch {
  calls: string[] = [];
  constructor(private readonly answer: (key: ProviderKey) => readonly SearchHit[]) {}
  async search(found: ProviderKey): Promise<readonly SearchHit[]> {
    this.calls.push(found.id);
    return this.answer(found);
  }
}

class FakeKeyedFetch implements KeyedFetch {
  calls: string[] = [];
  constructor(private readonly answer: (key: ProviderKey) => PageText) {}
  async fetch(found: ProviderKey): Promise<PageText> {
    this.calls.push(found.id);
    return this.answer(found);
  }
}

class FakePlainFetch implements WebFetch {
  calls = 0;
  constructor(private readonly answer: () => PageText) {}
  async fetch(): Promise<PageText> {
    this.calls++;
    return this.answer();
  }
}

/** Keys by provider. reserve hands out the first key of that provider, or undefined when none is left. */
class FakePool implements ProviderKeyPool {
  reserves: {provider: KeyedProvider; credits: number}[] = [];
  exhausted: string[] = [];
  constructor(private keys: ProviderKey[]) {}
  async reserve(provider: KeyedProvider, credits: number): Promise<ProviderKey | undefined> {
    this.reserves.push({provider, credits});
    const index = this.keys.findIndex(found => found.provider === provider);
    if (index < 0) return undefined;
    const [found] = this.keys.splice(index, 1);
    return found;
  }
  async exhaust(id: string): Promise<void> {
    this.exhausted.push(id);
  }
}

/** Records each check and charge. A check throws UserLimitError from the denyAt-th check on. */
class FakeCharge implements WebCharge {
  checks = 0;
  charges: {server: string; user: string; provider: WebProvider}[] = [];
  constructor(private readonly denyAt = Infinity) {}
  async check(): Promise<void> {
    this.checks++;
    if (this.checks >= this.denyAt) throw new UserLimitError(123);
  }
  async charge(server: string, user: string, provider: WebProvider): Promise<void> {
    this.charges.push({server, user, provider});
  }
}



class FakeKeyStore implements ProviderKeyStore {
  row: ProviderKeyRow | undefined;
  reserveCalls: {provider: KeyedProvider; month: string; credits: number; cap: number}[] = [];
  exhaustCalls: {id: string; month: string}[] = [];
  settingWrites: string[] = [];
  constructor(readonly values: Record<string, unknown>) {}
  setting(server: string, key: string): unknown {
    return server === GLOBAL_SETTINGS_SCOPE ? this.values[key] : undefined;
  }
  setSetting(server: string, key: string, value: unknown): void {
    if (server !== GLOBAL_SETTINGS_SCOPE) return;
    this.settingWrites.push(key);
    this.values[key] = value;
  }
  async listProviderKeys(): Promise<ProviderKeyRow[]> { return []; }
  async addProviderKey(): Promise<void> {}
  async deleteProviderKey(): Promise<boolean> { return false; }
  async reserveProviderCredits(provider: KeyedProvider, month: string, credits: number, cap: number): Promise<ProviderKeyRow | undefined> {
    this.reserveCalls.push({provider, month, credits, cap});
    return this.row;
  }
  async exhaustProviderKey(id: string, month: string): Promise<void> { this.exhaustCalls.push({id, month}); }
  async resetProviderKey(): Promise<void> {}
  async providerKeyUsage(): Promise<ProviderKeyUsage[]> { return []; }
}

const failure = (provider: WebProvider = 'searxng') => new ProviderFailed(provider, 'down');

test('SearXNG hits end the search chain before Tavily is called', async () => {
  const searxng = new FakeWebSearch(() => [hit('a')]);
  const tavily = new FakeKeyedSearch(() => [hit('t')]);
  const pool = new FakePool([key('tavily', 't1')]);
  const search = new FallbackSearch({searxng, tavily, pool});
  assert.deepEqual(await search.search('q', 3), [hit('a')]);
  assert.deepEqual(tavily.calls, []);
  assert.deepEqual(pool.reserves, []);
});

test('an empty SearXNG answer is final and does not call Tavily', async () => {
  const searxng = new FakeWebSearch(() => []);
  const tavily = new FakeKeyedSearch(() => [hit('t')]);
  const search = new FallbackSearch({searxng, tavily, pool: new FakePool([key('tavily', 't1')])});
  assert.deepEqual(await search.search('q', 3), []);
  assert.equal(searxng.calls, 1);
  assert.deepEqual(tavily.calls, []);
});

test('a failed SearXNG call moves to Tavily', async () => {
  const searxng = new FakeWebSearch(() => { throw failure(); });
  const tavily = new FakeKeyedSearch(() => [hit('t')]);
  const search = new FallbackSearch({searxng, tavily, pool: new FakePool([key('tavily', 't1')])});
  assert.deepEqual(await search.search('q', 3), [hit('t')]);
  assert.deepEqual(tavily.calls, ['t1']);
});

test('an exhausted Tavily key is marked and the next Tavily key is used', async () => {
  const tavily = new FakeKeyedSearch(found => {
    if (found.id === 't1') throw new ProviderFailed('tavily', 'quota', true);
    return [hit('t')];
  });
  const pool = new FakePool([key('tavily', 't1'), key('tavily', 't2')]);
  const search = new FallbackSearch({tavily, pool});
  assert.deepEqual(await search.search('q', 3), [hit('t')]);
  assert.deepEqual(tavily.calls, ['t1', 't2']);
  assert.deepEqual(pool.exhausted, ['t1']);
  assert.equal(pool.reserves.length, 2);
});

test('Tavily stops after three exhausted keys', async () => {
  const tavily = new FakeKeyedSearch(() => { throw new ProviderFailed('tavily', 'quota', true); });
  const pool = new FakePool([key('tavily', 't1'), key('tavily', 't2'), key('tavily', 't3'), key('tavily', 't4')]);
  const search = new FallbackSearch({tavily, pool});
  await assert.rejects(search.search('q', 3), (error: unknown) => error instanceof ToolError && error.status === 'failed');
  assert.deepEqual(tavily.calls, ['t1', 't2', 't3']);
  assert.equal(pool.reserves.length, 3);
});

test('all search steps failing ends in a ToolError', async () => {
  const search = new FallbackSearch({
    searxng: new FakeWebSearch(() => { throw failure(); }),
    tavily: new FakeKeyedSearch(() => { throw new Error('network'); }),
    firecrawl: new FakeKeyedSearch(() => { throw new ProviderFailed('firecrawl_search', 'bad'); }),
    pool: new FakePool([key('tavily', 't1'), key('firecrawl', 'f1')]),
  });
  await assert.rejects(search.search('q', 3), (error: unknown) => error instanceof ToolError && error.status === 'failed' && /unavailable/.test(error.message));
});

test('a user at the limit is stopped before any search service is called', async () => {
  const searxng = new FakeWebSearch(() => [hit('a')]);
  const tavily = new FakeKeyedSearch(() => [hit('t')]);
  const pool = new FakePool([key('tavily', 't1')]);
  const search = new FallbackSearch({searxng, tavily, pool, charge: new FakeCharge(1)});
  await assert.rejects(search.search('q', 3, who), (error: unknown) => error instanceof UserLimitError && error.resetAt === 123);
  assert.equal(searxng.calls, 0);
  assert.deepEqual(tavily.calls, []);
  assert.deepEqual(pool.reserves, []);
});

test('a limit reached after SearXNG fails stops the chain and is not a provider failure', async () => {
  const searxng = new FakeWebSearch(() => { throw failure(); });
  const tavily = new FakeKeyedSearch(() => [hit('t')]);
  const pool = new FakePool([key('tavily', 't1')]);
  const search = new FallbackSearch({searxng, tavily, pool, charge: new FakeCharge(2)});
  await assert.rejects(search.search('q', 3, who), UserLimitError);
  assert.equal(searxng.calls, 1);
  assert.deepEqual(tavily.calls, []);
  assert.deepEqual(pool.reserves, []);
});

test('a URL with credentials or a non-web scheme is refused before any paid step, and http is allowed', async () => {
  for (const url of ['https://user:pass@page.example/', 'https://user@page.example/', 'file:///etc/passwd', 'not a url']) {
    const scrape = new FakeKeyedFetch(() => page('scraped'));
    const pool = new FakePool([key('firecrawl', 'f1')]);
    const fetch = new FallbackFetch({plain: new FakePlainFetch(() => { throw failure('plain_fetch'); }), firecrawl: scrape, pool});
    await assert.rejects(fetch.fetch(url), (error: unknown) => error instanceof ToolError && error.status === 'rejected', url);
    assert.deepEqual(pool.reserves, [], url);
    assert.deepEqual(scrape.calls, [], url);
  }
  const plainHttp = new FallbackFetch({plain: new FakePlainFetch(() => { throw failure('plain_fetch'); }), firecrawl: new FakeKeyedFetch(() => page('scraped')), pool: new FakePool([key('firecrawl', 'f1')])});
  assert.deepEqual(await plainHttp.fetch('http://page.example/'), page('scraped'));
});

test('StoreKeyPool uses the saved caps, the UTC usage month and the opened secret', async () => {
  const store = new FakeKeyStore({[KEY_CAPS_SETTING]: {tavily: 300, firecrawl: 0}});
  store.row = {id: 'k1', provider: 'tavily', owner: 'o', label: 'main', last4: '1234', secretEncrypted: 'sealed', createdAt: 1};
  const pool = new StoreKeyPool(store, row => `open:${row.id}`);
  const now = Date.UTC(2026, 9, 13, 12);
  assert.equal(usageMonth(now), '2026-10');

  assert.deepEqual(await pool.reserve('tavily', 1, now), {id: 'k1', provider: 'tavily', secret: 'open:k1', last4: '1234'});
  assert.deepEqual(store.reserveCalls, [{provider: 'tavily', month: '2026-10', credits: 1, cap: 300}]);

  // Firecrawl has an invalid saved cap (0), so the default applies.
  await pool.reserve('firecrawl', 2, now);
  assert.equal(store.reserveCalls[1]?.cap, DEFAULT_KEY_CAPS.firecrawl);

  await pool.exhaust('k1', now);
  assert.deepEqual(store.exhaustCalls, [{id: 'k1', month: '2026-10'}]);

  store.row = undefined;
  assert.equal(await pool.reserve('tavily', 1, now), undefined);
});



/** Collects each console.log line. */
function captureLogs(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  return lines;
}

type StepLine = {type: string; provider: string; outcome: string; status?: string; message?: string; key?: string; ms: number; server?: string; host?: string};
/** The web_provider_step lines among the log lines. */
function stepLines(lines: string[]): StepLine[] {
  return lines.map(line => JSON.parse(line) as StepLine).filter(line => line.type === 'web_provider_step');
}

test('each provider step logs one web_provider_step line with no secret, query or URL', async t => {
  const lines = captureLogs(t);
  const pool = new FakePool([
    {id: 't1', provider: 'tavily', secret: 'tvly-secret-value-xyz', last4: '9876'},
    {id: 't2', provider: 'tavily', secret: 'other-secret-abc', last4: '1111'},
    {id: 'f1', provider: 'firecrawl', secret: 'fc-secret-qq', last4: '2222'},
  ]);
  const search = new FallbackSearch({
    searxng: new FakeWebSearch(() => { throw new ProviderFailed('searxng', 'SearXNG failed at https://searx.example/search?q=private+words', false, {status: '500'}); }),
    tavily: new FakeKeyedSearch(found => {
      if (found.id === 't1') throw new ProviderFailed('tavily', 'quota', true, {status: '432'});
      return [];
    }),
    firecrawl: new FakeKeyedSearch(() => [hit('f')]),
    pool,
  });
  assert.deepEqual(await search.search('private search words', 3, who), [hit('f')]);

  const steps = stepLines(lines);
  assert.deepEqual(steps.map(step => [step.provider, step.outcome, step.key]), [
    ['searxng', 'failed', undefined], ['tavily', 'key_exhausted', '9876'], ['tavily', 'empty', '1111'], ['firecrawl_search', 'ok', '2222'],
  ]);
  assert.equal(steps[0]?.status, '500');
  assert.equal(steps[0]?.message, 'SearXNG failed at [url]');
  assert.equal(steps[1]?.status, '432');
  assert.ok(steps.every(step => step.server === 's' && typeof step.ms === 'number' && step.host === undefined));
  const text = lines.join('\n');
  for (const leak of ['tvly-secret-value-xyz', 'other-secret-abc', 'fc-secret-qq', 'private', 'searx.example', '/search']) {
    assert.equal(text.includes(leak), false, leak);
  }
});
