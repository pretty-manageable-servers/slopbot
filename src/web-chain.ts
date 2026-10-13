import { ToolError } from './tools.js';
import type { PageFetch } from './web-fetch.js';
import { UserLimitError, type UserLimiter } from './user-limiter.js';
import { GLOBAL_SETTINGS_SCOPE } from './usage-cost.js';
import {
  CALL_CREDITS, DEFAULT_KEY_CAPS, KEY_CAPS_SETTING, ProviderFailed, WEB_COSTS_MICROS, WEB_COSTS_SETTING, usageMonth,
  type KeyedFetch, type KeyedProvider, type KeyedSearch, type PageText, type ProviderKey, type ProviderKeyPool,
  type ProviderKeyRow, type ProviderKeyStore, type WebCharge, type WebFetch, type WebProvider,
} from './web-providers.js';
import { SEARCH_NOT_CONFIGURED, type SearchHit, type WebSearch, type WebUser } from './web-search.js';

/** Most keys one call tries. A key that runs out is replaced. Any other failure ends that step. */
const KEY_ATTEMPTS = 3;
const SEARCH_UNAVAILABLE = 'Web search is unavailable right now. Try again later.';
const FETCH_NOT_CONFIGURED = 'Web fetch is not configured. Add a Firecrawl key in the admin panel.';
const FETCH_UNAVAILABLE = 'Web fetch is unavailable right now. Try again later.';

/** A saved setting that is a plain object, or undefined. */
function savedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Refuses when the user is at a limit. Does nothing when there is no user to charge. */
async function admit(charge: WebCharge | undefined, who: WebUser | undefined): Promise<void> {
  if (charge && who) await charge.check(who.server, who.user);
}

/** Records one call to the user's limits. Does nothing when there is no user to charge. */
async function bill(charge: WebCharge | undefined, who: WebUser | undefined, provider: WebProvider): Promise<void> {
  if (charge && who) await charge.charge(who.server, who.user, provider);
}

/** One call that needs no key. Returns undefined when it fails, so the chain moves on. */
async function metered<T>(charge: WebCharge | undefined, who: WebUser | undefined, provider: WebProvider, call: () => Promise<T>): Promise<T | undefined> {
  await admit(charge, who);
  await bill(charge, who, provider);
  try { return await call(); } catch { return undefined; }
}

/**
 * One call with a team key. Returns undefined when no key has room or the call failed, so the chain moves on.
 * An exhausted key is marked for the month and the call is tried with the next key.
 * A failed call is never retried with the same key, because it may still have used a credit.
 */
async function withKey<T>(pool: ProviderKeyPool, charge: WebCharge | undefined, who: WebUser | undefined, keyed: KeyedProvider, provider: WebProvider, credits: number, call: (key: ProviderKey) => Promise<T>): Promise<T | undefined> {
  for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt++) {
    await admit(charge, who);
    const key = await pool.reserve(keyed, credits);
    if (!key) return undefined;
    await bill(charge, who, provider);
    try { return await call(key); } catch (error) {
      if (!(error instanceof ProviderFailed && error.keyExhausted)) return undefined;
      await pool.exhaust(key.id);
    }
  }
  return undefined;
}

/** Charges the user's 5h and weekly limits. The cost of each provider comes from a saved setting, or the default. */
export class LimiterWebCharge implements WebCharge {
  constructor(private readonly limiter: Pick<UserLimiter, 'check' | 'record'>, private readonly settings: { setting(server: string, key: string): unknown }) {}

  async check(server: string, user: string): Promise<void> {
    const limit = await this.limiter.check(server, user);
    if (!limit.allowed) throw new UserLimitError(limit.resetAt);
  }

  async charge(server: string, user: string, provider: WebProvider): Promise<void> {
    await this.limiter.record(server, user, this.cost(provider));
  }

  private cost(provider: WebProvider): number {
    const saved = savedRecord(this.settings.setting(GLOBAL_SETTINGS_SCOPE, WEB_COSTS_SETTING))?.[provider];
    return typeof saved === 'number' && Number.isSafeInteger(saved) && saved >= 0 ? saved : WEB_COSTS_MICROS[provider];
  }
}

/** Picks team keys from the store. The store makes each reserve atomic. The key secret is opened only for one call. */
export class StoreKeyPool implements ProviderKeyPool {
  constructor(private readonly store: ProviderKeyStore & { setting(server: string, key: string): unknown }, private readonly open: (row: ProviderKeyRow) => string) {}

  async reserve(provider: KeyedProvider, credits: number, now = Date.now()): Promise<ProviderKey | undefined> {
    const row = await this.store.reserveProviderCredits(provider, usageMonth(now), credits, this.cap(provider));
    return row ? { id: row.id, provider: row.provider, secret: this.open(row) } : undefined;
  }

  async exhaust(id: string, now = Date.now()): Promise<void> {
    await this.store.exhaustProviderKey(id, usageMonth(now));
  }

  private cap(provider: KeyedProvider): number {
    const saved = savedRecord(this.store.setting(GLOBAL_SETTINGS_SCOPE, KEY_CAPS_SETTING))?.[provider];
    return typeof saved === 'number' && Number.isSafeInteger(saved) && saved > 0 ? saved : DEFAULT_KEY_CAPS[provider];
  }
}

export interface FallbackSearchOptions { searxng?: WebSearch; tavily?: KeyedSearch; firecrawl?: KeyedSearch; pool?: ProviderKeyPool; charge?: WebCharge }

/**
 * Web search chain. SearXNG first. Then Tavily, then Firecrawl.
 * Hits or an empty answer from SearXNG, Tavily or Firecrawl end the chain. An empty answer from SearXNG ends it without a Tavily call.
 * A failure moves to the next step. Every step is charged to the user before its call.
 */
export class FallbackSearch implements WebSearch {
  constructor(private readonly options: FallbackSearchOptions) {}

  async search(query: string, limit: number, who?: WebUser): Promise<readonly SearchHit[]> {
    const { searxng, tavily, firecrawl, pool, charge } = this.options;
    if (!searxng && !(tavily && pool) && !(firecrawl && pool)) throw new ToolError(SEARCH_NOT_CONFIGURED);
    if (searxng) {
      const hits = await metered(charge, who, 'searxng', () => searxng.search(query, limit));
      if (hits) return hits;
    }
    if (tavily && pool) {
      const hits = await withKey(pool, charge, who, 'tavily', 'tavily', CALL_CREDITS.tavily, key => tavily.search(key, query, limit));
      if (hits?.length) return hits;
    }
    if (firecrawl && pool) {
      const hits = await withKey(pool, charge, who, 'firecrawl', 'firecrawl_search', CALL_CREDITS.firecrawl_search, key => firecrawl.search(key, query, limit));
      if (hits) return hits;
    }
    throw new ToolError(SEARCH_UNAVAILABLE, 'failed');
  }
}

export interface FallbackFetchOptions { plain?: WebFetch; firecrawl?: KeyedFetch; pool?: ProviderKeyPool; charge?: WebCharge }

/** Only a plain http or https URL with no credentials may go to a paid service. */
function assertWebUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ToolError('Use a full http or https URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new ToolError('Use an http or https URL without a username or password.');
}

/**
 * Page fetch chain. Plain fetch first, then a Firecrawl scrape.
 * Only a ProviderFailed from plain fetch moves on. Any other error (for example a blocked URL or a limit) ends the fetch.
 */
export class FallbackFetch implements PageFetch {
  constructor(private readonly options: FallbackFetchOptions) {}

  async fetch(url: string, who?: WebUser): Promise<PageText> {
    const { plain, firecrawl, pool, charge } = this.options;
    if (!plain && !(firecrawl && pool)) throw new ToolError(FETCH_NOT_CONFIGURED);
    if (plain) {
      await admit(charge, who);
      await bill(charge, who, 'plain_fetch');
      try { return await plain.fetch(url); } catch (error) {
        if (!(error instanceof ProviderFailed)) throw error;
      }
    }
    if (firecrawl && pool) {
      assertWebUrl(url);
      const page = await withKey(pool, charge, who, 'firecrawl', 'firecrawl_scrape', CALL_CREDITS.firecrawl_scrape, key => firecrawl.fetch(key, url));
      if (page) return page;
    }
    throw new ToolError(FETCH_UNAVAILABLE, 'failed');
  }
}
