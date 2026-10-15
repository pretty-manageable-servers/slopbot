import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {FallbackFetch, FallbackSearch, LimiterWebCharge, StoreKeyPool} from '../src/web-chain.js';
import {registerWebFetch} from '../src/web-fetch.js';
import {SQLiteStore} from '../src/adapters/sqlite.js';
import {ToolError, ToolRegistry} from '../src/tools.js';
import {UserLimitError, type UserLimit} from '../src/user-limiter.js';
import {GLOBAL_SETTINGS_SCOPE} from '../src/usage-cost.js';
import {
  CALL_CREDITS, DEFAULT_KEY_CAPS, FETCH_TEXT_LIMIT, KEY_CAPS_SETTING, KEY_ERRORS_SETTING, ProviderFailed, WEB_COSTS_MICROS, WEB_COSTS_SETTING, usageMonth,
  type KeyError, type KeyedFetch, type KeyedProvider, type KeyedSearch, type PageText, type ProviderKey, type ProviderKeyPool,
  type ProviderKeyRow, type ProviderKeyStore, type ProviderKeyUsage, type WebCharge, type WebFetch, type WebProvider,
} from '../src/web-providers.js';
import type {SearchHit, WebSearch, WebUser} from '../src/web-search.js';

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

class FakeLimiter {
  checks: string[] = [];
  records: {user: string; cost: number}[] = [];
  constructor(private readonly limit: UserLimit = {allowed: true}) {}
  async check(user: string): Promise<UserLimit> {
    this.checks.push(user);
    return this.limit;
  }
  async record(user: string, cost: number): Promise<void> {
    this.records.push({user, cost});
  }
}

function settingsFrom(values: Record<string, unknown>): {setting(server: string, key: string): unknown} {
  return {setting: (server, key) => server === GLOBAL_SETTINGS_SCOPE ? values[key] : undefined};
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

test('an empty Tavily answer moves to Firecrawl', async () => {
  const tavily = new FakeKeyedSearch(() => []);
  const firecrawl = new FakeKeyedSearch(() => [hit('f')]);
  const pool = new FakePool([key('tavily', 't1'), key('firecrawl', 'f1')]);
  const search = new FallbackSearch({tavily, firecrawl, pool});
  assert.deepEqual(await search.search('q', 3), [hit('f')]);
  assert.deepEqual(tavily.calls, ['t1']);
  assert.deepEqual(firecrawl.calls, ['f1']);
  assert.deepEqual(pool.reserves, [{provider: 'tavily', credits: CALL_CREDITS.tavily}, {provider: 'firecrawl', credits: CALL_CREDITS.firecrawl_search}]);
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

test('a Tavily failure that is not an exhausted key does not retry the same key', async () => {
  const tavily = new FakeKeyedSearch(() => { throw new ProviderFailed('tavily', 'timeout'); });
  const firecrawl = new FakeKeyedSearch(() => [hit('f')]);
  const pool = new FakePool([key('tavily', 't1'), key('firecrawl', 'f1')]);
  const search = new FallbackSearch({tavily, firecrawl, pool});
  assert.deepEqual(await search.search('q', 3), [hit('f')]);
  assert.deepEqual(tavily.calls, ['t1']);
  assert.deepEqual(pool.exhausted, []);
});

test('Tavily stops after three exhausted keys', async () => {
  const tavily = new FakeKeyedSearch(() => { throw new ProviderFailed('tavily', 'quota', true); });
  const pool = new FakePool([key('tavily', 't1'), key('tavily', 't2'), key('tavily', 't3'), key('tavily', 't4')]);
  const search = new FallbackSearch({tavily, pool});
  await assert.rejects(search.search('q', 3), (error: unknown) => error instanceof ToolError && error.status === 'failed');
  assert.deepEqual(tavily.calls, ['t1', 't2', 't3']);
  assert.equal(pool.reserves.length, 3);
});

test('a Tavily step with no key room is skipped', async () => {
  const tavily = new FakeKeyedSearch(() => [hit('t')]);
  const firecrawl = new FakeKeyedSearch(() => [hit('f')]);
  const pool = new FakePool([key('firecrawl', 'f1')]);
  const search = new FallbackSearch({tavily, firecrawl, pool});
  assert.deepEqual(await search.search('q', 3), [hit('f')]);
  assert.deepEqual(tavily.calls, []);
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

test('a search chain with nothing configured names SEARXNG_URL and the admin panel', async () => {
  await assert.rejects(new FallbackSearch({}).search('q', 3), (error: unknown) => error instanceof ToolError && /SEARXNG_URL/.test(error.message) && /admin panel/.test(error.message));
});

test('charges go to the right providers with the default and saved costs', async () => {
  const limiter = new FakeLimiter();
  const charge = new LimiterWebCharge(limiter, settingsFrom({[WEB_COSTS_SETTING]: {tavily: 7}}));
  const search = new FallbackSearch({
    searxng: new FakeWebSearch(() => { throw failure(); }),
    tavily: new FakeKeyedSearch(() => []),
    firecrawl: new FakeKeyedSearch(() => [hit('f')]),
    pool: new FakePool([key('tavily', 't1'), key('firecrawl', 'f1')]),
    charge,
  });
  assert.deepEqual(await search.search('q', 3, who), [hit('f')]);
  assert.deepEqual(limiter.checks, ['u', 'u', 'u']);
  assert.deepEqual(limiter.records, [
    {user: 'u', cost: WEB_COSTS_MICROS.searxng},
    {user: 'u', cost: 7},
    {user: 'u', cost: WEB_COSTS_MICROS.firecrawl_search},
  ]);
});

test('charge costs fall back to the defaults when the saved value is not a safe whole number', async () => {
  const limiter = new FakeLimiter();
  const charge = new LimiterWebCharge(limiter, settingsFrom({[WEB_COSTS_SETTING]: {searxng: -5, plain_fetch: 1.5, tavily: '9'}}));
  await charge.charge('s', 'u', 'searxng');
  await charge.charge('s', 'u', 'plain_fetch');
  await charge.charge('s', 'u', 'tavily');
  assert.deepEqual(limiter.records.map(record => record.cost), [WEB_COSTS_MICROS.searxng, WEB_COSTS_MICROS.plain_fetch, WEB_COSTS_MICROS.tavily]);
});

test('a saved cost in another scope is ignored', async () => {
  const limiter = new FakeLimiter();
  const other = {setting: (server: string, key: string) => server === 'other-server' && key === WEB_COSTS_SETTING ? {searxng: 99} : undefined};
  await new LimiterWebCharge(limiter, other).charge('s', 'u', 'searxng');
  assert.deepEqual(limiter.records.map(record => record.cost), [WEB_COSTS_MICROS.searxng]);
});

test('LimiterWebCharge throws UserLimitError with the reset time when the user is at the limit', async () => {
  const charge = new LimiterWebCharge(new FakeLimiter({allowed: false, resetAt: 555}), settingsFrom({}));
  await assert.rejects(charge.check('s', 'u'), (error: unknown) => error instanceof UserLimitError && error.resetAt === 555);
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

test('without a user no charge is made', async () => {
  const charge = new FakeCharge(1);
  const search = new FallbackSearch({searxng: new FakeWebSearch(() => [hit('a')]), charge});
  assert.deepEqual(await search.search('q', 3), [hit('a')]);
  assert.equal(charge.checks, 0);
  assert.deepEqual(charge.charges, []);
});

test('a plain fetch ToolError ends the fetch: no key is reserved and Firecrawl is not called', async () => {
  const blocked = new ToolError('Private address blocked.');
  const scrape = new FakeKeyedFetch(() => page('scraped'));
  const pool = new FakePool([key('firecrawl', 'f1')]);
  const fetch = new FallbackFetch({plain: {fetch: async () => { throw blocked; }}, firecrawl: scrape, pool});
  await assert.rejects(fetch.fetch('https://page.example/', who), (error: unknown) => error === blocked);
  assert.deepEqual(pool.reserves, []);
  assert.deepEqual(scrape.calls, []);
});

test('a plain fetch ProviderFailed runs the Firecrawl scrape', async () => {
  const scrape = new FakeKeyedFetch(() => page('scraped'));
  const pool = new FakePool([key('firecrawl', 'f1')]);
  const fetch = new FallbackFetch({plain: new FakePlainFetch(() => { throw failure('plain_fetch'); }), firecrawl: scrape, pool});
  assert.deepEqual(await fetch.fetch('https://page.example/', who), page('scraped'));
  assert.deepEqual(scrape.calls, ['f1']);
  assert.deepEqual(pool.reserves, [{provider: 'firecrawl', credits: CALL_CREDITS.firecrawl_scrape}]);
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

test('fetch tries plain fetch, then a Firecrawl scrape', async () => {
  const plain = new FakePlainFetch(() => { throw failure('plain_fetch'); });
  const scrape = new FakeKeyedFetch(() => page('scraped'));
  const pool = new FakePool([key('firecrawl', 'f1')]);
  const charge = new FakeCharge();
  const fetch = new FallbackFetch({plain, firecrawl: scrape, pool, charge});
  assert.deepEqual(await fetch.fetch('https://page.example/', who), page('scraped'));
  assert.deepEqual(scrape.calls, ['f1']);
  assert.deepEqual(pool.reserves, [{provider: 'firecrawl', credits: CALL_CREDITS.firecrawl_scrape}]);
  assert.deepEqual(charge.charges.map(item => item.provider), ['plain_fetch', 'firecrawl_scrape']);
});

test('a successful plain fetch does not call Firecrawl', async () => {
  const scrape = new FakeKeyedFetch(() => page('scraped'));
  const fetch = new FallbackFetch({plain: new FakePlainFetch(() => page('plain')), firecrawl: scrape, pool: new FakePool([key('firecrawl', 'f1')])});
  assert.deepEqual(await fetch.fetch('https://page.example/'), page('plain'));
  assert.deepEqual(scrape.calls, []);
});

test('a failed scrape is not retried with the same key, and an exhausted key is replaced', async () => {
  const failed = new FakeKeyedFetch(() => { throw new ProviderFailed('firecrawl_scrape', 'bad'); });
  const failedFetch = new FallbackFetch({firecrawl: failed, pool: new FakePool([key('firecrawl', 'f1')])});
  await assert.rejects(failedFetch.fetch('https://page.example/'), (error: unknown) => error instanceof ToolError && error.status === 'failed');
  assert.deepEqual(failed.calls, ['f1']);

  const exhausted = new FakeKeyedFetch(found => {
    if (found.id === 'f1') throw new ProviderFailed('firecrawl_scrape', 'credits', true);
    return page('second key');
  });
  const pool = new FakePool([key('firecrawl', 'f1'), key('firecrawl', 'f2')]);
  assert.deepEqual(await new FallbackFetch({firecrawl: exhausted, pool}).fetch('https://page.example/'), page('second key'));
  assert.deepEqual(exhausted.calls, ['f1', 'f2']);
  assert.deepEqual(pool.exhausted, ['f1']);
});

test('a user at the limit is stopped before plain fetch', async () => {
  const plain = new FakePlainFetch(() => page('plain'));
  const fetch = new FallbackFetch({plain, charge: new FakeCharge(1)});
  await assert.rejects(fetch.fetch('https://page.example/', who), UserLimitError);
  assert.equal(plain.calls, 0);
});

test('web_fetch gives the page text, the source and a note when the text is cut', async t => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  const long = 'x'.repeat(FETCH_TEXT_LIMIT + 10);
  let text = long;
  let truncated = false;
  registerWebFetch(registry, {fetch: async (_url, asker) => {
    assert.deepEqual(asker, {server: 's', user: 'a'});
    return {url: 'https://page.example/', title: 'Long page', text, truncated};
  }});
  const message = {id: 'm', server: 's', channel: 'c', author: 'a', text: 'fetch'};

  const cut = await registry.invokeResult(message, 'web_fetch', {url: 'https://page.example/'}, 'one', 'agent');
  assert.equal(cut.text, `Long page\nhttps://page.example/\n\n${'x'.repeat(FETCH_TEXT_LIMIT)}\n\n[Text cut at ${FETCH_TEXT_LIMIT} characters]`);
  assert.deepEqual(cut.data, {title: 'Long page', url: 'https://page.example/', text: 'x'.repeat(FETCH_TEXT_LIMIT), truncated: true});
  assert.deepEqual(cut.sources, [{kind: 'web', url: 'https://page.example/', title: 'Long page'}]);

  text = 'short';
  truncated = false;
  const whole = await registry.invokeResult(message, 'web_fetch', {url: 'https://page.example/'}, 'two', 'agent');
  assert.equal(whole.text, 'Long page\nhttps://page.example/\n\nshort');
  assert.deepEqual(whole.data, {title: 'Long page', url: 'https://page.example/', text: 'short', truncated: false});
});

test('web_fetch routes GitHub reads to shell without fetching HTML or counting a block', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registerWebFetch(registry, { fetch: async () => { throw new Error('GitHub must not be fetched'); } });
  const message = { id: 'm', server: 's', channel: 'c', author: 'a', text: 'read releases' };
  for (const host of ['github.com', 'www.github.com', 'api.github.com', 'raw.githubusercontent.com']) {
    const result = await registry.invokeResult(message, 'web_fetch', { url: `https://${host}/o/r/releases` }, host, 'agent');
    assert.match(result.text, /shell.*curl/); assert.notEqual(result.status, 'rejected');
  }
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

test('StoreKeyPool falls back to the default caps when no caps are saved', async () => {
  const store = new FakeKeyStore({});
  await new StoreKeyPool(store, () => 'secret').reserve('tavily', 1, Date.UTC(2026, 0, 1));
  assert.deepEqual(store.reserveCalls, [{provider: 'tavily', month: '2026-01', credits: 1, cap: DEFAULT_KEY_CAPS.tavily}]);
});

/** Keys with recordError and clearError. Records each call. */
class ErrorPool extends FakePool {
  recorded: {id: string; error: KeyError}[] = [];
  cleared: string[] = [];
  async recordError(id: string, error: KeyError): Promise<void> { this.recorded.push({id, error}); }
  async clearError(id: string): Promise<void> { this.cleared.push(id); }
}

/** Key error writes that always fail. */
class BrokenErrorPool extends FakePool {
  async recordError(): Promise<void> { throw new Error('store down'); }
  async clearError(): Promise<void> { throw new Error('store down'); }
}

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

test('fetch step logs carry the host only, never the path or query', async t => {
  const lines = captureLogs(t);
  const fetch = new FallbackFetch({
    plain: new FakePlainFetch(() => { throw new ProviderFailed('plain_fetch', 'No text at https://page.example/private/path?token=abc', false, {status: 'empty'}); }),
    firecrawl: new FakeKeyedFetch(() => page('scraped')),
    pool: new FakePool([{id: 'f1', provider: 'firecrawl', secret: 'fc-secret-zz', last4: '3333'}]),
  });
  assert.deepEqual(await fetch.fetch('https://page.example/private/path?token=abc', who), page('scraped'));

  const steps = stepLines(lines);
  assert.deepEqual(steps.map(step => [step.provider, step.outcome, step.host]), [['plain_fetch', 'failed', 'page.example'], ['firecrawl_scrape', 'ok', 'page.example']]);
  assert.equal(steps[0]?.status, 'empty');
  assert.equal(steps[1]?.key, '3333');
  const text = lines.join('\n');
  for (const leak of ['/private/path', 'token=abc', 'fc-secret-zz']) assert.equal(text.includes(leak), false, leak);
});

test('a keyed step with no key room logs skipped_no_key', async t => {
  const lines = captureLogs(t);
  const search = new FallbackSearch({tavily: new FakeKeyedSearch(() => [hit('t')]), firecrawl: new FakeKeyedSearch(() => [hit('f')]), pool: new FakePool([key('firecrawl', 'f1')])});
  assert.deepEqual(await search.search('q', 3), [hit('f')]);
  assert.deepEqual(stepLines(lines).map(step => [step.provider, step.outcome]), [['tavily', 'skipped_no_key'], ['firecrawl_search', 'ok']]);
});

test('a failed key call is recorded with its status, message and exhausted flag', async () => {
  const cases: [string, boolean][] = [['401', true], ['432', true], ['500', false], ['network', false]];
  for (const [status, exhausted] of cases) {
    const pool = new ErrorPool([key('tavily', 't1')]);
    const search = new FallbackSearch({tavily: new FakeKeyedSearch(() => { throw new ProviderFailed('tavily', 'Tavily failed', exhausted, {status}); }), pool});
    await assert.rejects(search.search('q', 3), ToolError);
    assert.deepEqual(pool.recorded.map(({id, error}) => ({id, status: error.status, message: error.message, exhausted: error.exhausted})), [{id: 't1', status, message: 'Tavily failed', exhausted}], status);
    assert.equal(typeof pool.recorded[0]?.error.at, 'number');
  }
});

test('an error that is not a ProviderFailed is recorded as unexpected, without its text', async () => {
  const pool = new ErrorPool([key('tavily', 't1')]);
  const search = new FallbackSearch({tavily: new FakeKeyedSearch(() => { throw new Error('leaked secret-x'); }), pool});
  await assert.rejects(search.search('q', 3), ToolError);
  assert.deepEqual(pool.recorded.map(({error}) => [error.status, error.message, error.exhausted]), [['unexpected', 'The provider call threw an unexpected error.', false]]);
});

test('a success clears the saved error of its key', async () => {
  const pool = new ErrorPool([key('tavily', 't1')]);
  const search = new FallbackSearch({tavily: new FakeKeyedSearch(() => [hit('t')]), pool});
  assert.deepEqual(await search.search('q', 3), [hit('t')]);
  assert.deepEqual(pool.cleared, ['t1']);
  assert.deepEqual(pool.recorded, []);
});

test('a key error that cannot be saved is logged, and the search still answers', async t => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { warnings.push(line); });
  captureLogs(t);
  const search = new FallbackSearch({
    tavily: new FakeKeyedSearch(() => { throw new ProviderFailed('tavily', 'down', false, {status: '500'}); }),
    firecrawl: new FakeKeyedSearch(() => [hit('f')]),
    pool: new BrokenErrorPool([key('tavily', 't1'), key('firecrawl', 'f1')]),
  });
  assert.deepEqual(await search.search('q', 3), [hit('f')]);
  assert.match(warnings.join('\n'), /web_key_error_record_failed/);
  const cleared = new FallbackSearch({tavily: new FakeKeyedSearch(() => [hit('t')]), pool: new BrokenErrorPool([key('tavily', 't1')])});
  assert.deepEqual(await cleared.search('q', 3), [hit('t')]);
  assert.match(warnings.join('\n'), /web_key_error_clear_failed/);
});

test('StoreKeyPool saves key errors in the global setting and clears them', async () => {
  const store = new FakeKeyStore({});
  const pool = new StoreKeyPool(store, () => 'secret');
  const error: KeyError = {at: 5, status: '401', message: 'bad key', exhausted: true};
  await pool.recordError('k1', error);
  assert.deepEqual(store.values[KEY_ERRORS_SETTING], {k1: error});
  await pool.clearError('k1');
  assert.deepEqual(store.values[KEY_ERRORS_SETTING], {});
  assert.equal(store.settingWrites.length, 2);
  await pool.clearError('k1');
  assert.equal(store.settingWrites.length, 2, 'clearError writes nothing when the key has no saved error');
});

test('a success through StoreKeyPool clears the saved error of the key', async () => {
  const store = new FakeKeyStore({[KEY_ERRORS_SETTING]: {k1: {at: 5, status: '500', message: 'down', exhausted: false}}});
  store.row = {id: 'k1', provider: 'tavily', owner: 'o', label: 'main', last4: '1234', secretEncrypted: 'sealed', createdAt: 1};
  const search = new FallbackSearch({tavily: new FakeKeyedSearch(() => [hit('t')]), pool: new StoreKeyPool(store, () => 'secret')});
  assert.deepEqual(await search.search('q', 3), [hit('t')]);
  assert.deepEqual(store.values[KEY_ERRORS_SETTING], {});
});

test('StoreKeyPool keeps the newest 50 key errors and ignores saved entries of the wrong shape', async () => {
  const store = new FakeKeyStore({[KEY_ERRORS_SETTING]: {bad: 'not an error'}});
  const pool = new StoreKeyPool(store, () => 'secret');
  for (let i = 1; i <= 51; i++) await pool.recordError(`k${i}`, {at: i, status: '500', message: 'down', exhausted: false});
  const saved = store.values[KEY_ERRORS_SETTING] as Record<string, unknown>;
  assert.equal(Object.keys(saved).length, 50);
  assert.equal('k1' in saved, false);
  assert.equal('k2' in saved, true);
  assert.equal('k51' in saved, true);
  assert.equal('bad' in saved, false);
});
