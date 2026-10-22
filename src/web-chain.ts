import { ToolError } from './tools.js';
import { logError, redactErrorText } from './errors.js';
import type { Json } from './domain.js';
import type { PageFetch } from './web-fetch.js';
import { UserLimitError, type UserLimiter } from './user-limiter.js';
import { GLOBAL_SETTINGS_SCOPE } from './usage-cost.js';
import {
  CALL_CREDITS, DEFAULT_KEY_CAPS, KEY_CAPS_SETTING, KEY_ERRORS_SETTING, ProviderFailed, WEB_COSTS_MICROS, WEB_COSTS_SETTING, usageMonth,
  type KeyError, type KeyedFetch, type KeyedProvider, type KeyedSearch, type PageText, type ProviderKey, type ProviderKeyPool,
  type ProviderKeyRow, type ProviderKeyStore, type WebCharge, type WebFetch, type WebProvider,
} from './web-providers.js';
import { SEARCH_NOT_CONFIGURED, type SearchHit, type WebSearch, type WebUser } from './web-search.js';

/** Most keys one call tries. A key that runs out is replaced. Any other failure ends that step. */
const KEY_ATTEMPTS = 3;
const SEARCH_UNAVAILABLE = 'Web search is unavailable right now. Try again later.';
const FETCH_NOT_CONFIGURED = 'Web fetch is not set up on this server.';
const FETCH_UNAVAILABLE = 'Web fetch is unavailable right now. Try again later.';
/** Reason words for the HTTP statuses a site answers with on purpose. Other 4xx statuses say "client error". */
const HTTP_REASONS: Record<number, string> = { 401: 'unauthorized', 403: 'forbidden', 404: 'not found', 410: 'gone', 429: 'too many requests' };

/** What the model is told when the site answered for certain. Not an outage, so it does not say "try again later". */
function siteAnswerMessage(url: string, answer: ProviderFailed): string {
  const httpStatus = answer.siteAnswer?.httpStatus;
  if (httpStatus !== undefined) return `The page returned HTTP ${httpStatus} (${HTTP_REASONS[httpStatus] ?? 'client error'}): ${url}. Check the URL or search for the current page.`;
  return `The page cannot be read here: ${url}. ${answer.message} Check the URL or search for another source.`;
}

/** A saved setting that is a plain object, or undefined. */
function savedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Most key errors kept in the setting. The oldest are dropped first. */
const KEY_ERROR_LIMIT = 50;

/** Text for logs and saved key errors: no URL, no control characters, at most 200 characters. */
function safeText(text: string): string {
  return redactErrorText(text).replace(/\bhttps?:\/\/\S+/gi, '[url]').slice(0, 200);
}

/** Status and message of a failed call. An error that is not a ProviderFailed is reported as unexpected, without its text. */
function failureDetails(error: unknown): { status: string; message: string } {
  if (error instanceof ProviderFailed) return { status: error.status ?? 'unknown', message: safeText(error.message) };
  return { status: 'unexpected', message: 'The provider call threw an unexpected error.' };
}

/** A list with no items is an empty answer. Any other answer is ok. */
function outcomeOf(value: unknown): 'ok' | 'empty' {
  return Array.isArray(value) && value.length === 0 ? 'empty' : 'ok';
}

/** Host of a page URL, for logs. Undefined when the URL does not parse. The path and query are never logged. */
function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname || undefined; } catch { return undefined; }
}

type StepOutcome = 'ok' | 'empty' | 'failed' | 'skipped_no_key' | 'key_exhausted';
interface StepLog { provider: WebProvider; outcome: StepOutcome; started: number; server?: string | undefined; host?: string | undefined; key?: string | undefined; status?: string | undefined; message?: string | undefined }

/** One JSON line for one provider step. Never holds the query, a URL path or query, or a secret. */
function logStep(step: StepLog): void {
  console.log(JSON.stringify({ type: 'web_provider_step', provider: step.provider, outcome: step.outcome, status: step.status, message: step.message, key: step.key, ms: Date.now() - step.started, server: step.server, host: step.host }));
}

/** Saves the last error of a key. A failure to save is logged and never breaks the search. */
async function recordKeyError(pool: ProviderKeyPool, id: string, error: KeyError): Promise<void> {
  try { await pool.recordError?.(id, error); } catch (failure) { logError('web_key_error_record_failed', failure, { stage: 'web_key_error' }, true); }
}

/** Clears the saved last error of a key after a success. A failure is logged and never breaks the search. */
async function clearKeyError(pool: ProviderKeyPool, id: string): Promise<void> {
  try { await pool.clearError?.(id); } catch (failure) { logError('web_key_error_clear_failed', failure, { stage: 'web_key_error' }, true); }
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
  const started = Date.now();
  try {
    const value = await call();
    logStep({ provider, outcome: outcomeOf(value), started, server: who?.server });
    return value;
  } catch (error) {
    logStep({ provider, outcome: 'failed', ...failureDetails(error), started, server: who?.server });
    return undefined;
  }
}

/**
 * One call with a team key. Returns undefined when no key has room or the call failed, so the chain moves on.
 * An exhausted key is marked for the month and the call is tried with the next key.
 * A failed call is never retried with the same key, because it may still have used a credit.
 */
async function withKey<T>(pool: ProviderKeyPool, charge: WebCharge | undefined, who: WebUser | undefined, keyed: KeyedProvider, provider: WebProvider, credits: number, call: (key: ProviderKey) => Promise<T>, host?: string): Promise<T | undefined> {
  const server = who?.server;
  for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt++) {
    await admit(charge, who);
    const started = Date.now();
    const key = await pool.reserve(keyed, credits);
    if (!key) {
      logStep({ provider, outcome: 'skipped_no_key', started, server, host });
      return undefined;
    }
    await bill(charge, who, provider);
    let value: T;
    try { value = await call(key); } catch (error) {
      const exhausted = error instanceof ProviderFailed && error.keyExhausted;
      const failure = failureDetails(error);
      logStep({ provider, outcome: exhausted ? 'key_exhausted' : 'failed', ...failure, key: key.last4, started, server, host });
      await recordKeyError(pool, key.id, { at: Date.now(), ...failure, exhausted });
      if (!exhausted) return undefined;
      await pool.exhaust(key.id);
      continue;
    }
    logStep({ provider, outcome: outcomeOf(value), key: key.last4, started, server, host });
    await clearKeyError(pool, key.id);
    return value;
  }
  return undefined;
}

/** Charges the user's 5h and weekly limits. The cost of each provider comes from a saved setting, or the default. */
export class LimiterWebCharge implements WebCharge {
  constructor(private readonly limiter: Pick<UserLimiter, 'check' | 'record'>, private readonly settings: { setting(server: string, key: string): unknown }) {}

  async check(_server: string, user: string): Promise<void> {
    const limit = await this.limiter.check(user);
    if (!limit.allowed) throw new UserLimitError(limit.resetAt);
  }

  async charge(_server: string, user: string, provider: WebProvider): Promise<void> {
    await this.limiter.record(user, this.cost(provider));
  }

  private cost(provider: WebProvider): number {
    const saved = savedRecord(this.settings.setting(GLOBAL_SETTINGS_SCOPE, WEB_COSTS_SETTING))?.[provider];
    return typeof saved === 'number' && Number.isSafeInteger(saved) && saved >= 0 ? saved : WEB_COSTS_MICROS[provider];
  }
}

/** Picks team keys from the store. The store makes each reserve atomic. The key secret is opened only for one call. */
export class StoreKeyPool implements ProviderKeyPool {
  constructor(private readonly store: ProviderKeyStore & { setting(server: string, key: string): unknown; setSetting(server: string, key: string, value: Json): void | Promise<void> }, private readonly open: (row: ProviderKeyRow) => string) {}

  async reserve(provider: KeyedProvider, credits: number, now = Date.now()): Promise<ProviderKey | undefined> {
    const row = await this.store.reserveProviderCredits(provider, usageMonth(now), credits, this.cap(provider));
    return row ? { id: row.id, provider: row.provider, secret: this.open(row), last4: row.last4 } : undefined;
  }

  async exhaust(id: string, now = Date.now()): Promise<void> {
    await this.store.exhaustProviderKey(id, usageMonth(now));
  }

  /** Saves the last error of a key. Keeps the newest KEY_ERROR_LIMIT errors. */
  async recordError(id: string, error: KeyError): Promise<void> {
    const errors = this.keyErrors();
    errors[id] = error;
    await this.saveKeyErrors(errors);
  }

  /** Removes the saved last error of a key. Writes nothing when the key has no saved error. */
  async clearError(id: string): Promise<void> {
    const errors = this.keyErrors();
    if (!(id in errors)) return;
    delete errors[id];
    await this.saveKeyErrors(errors);
  }

  /** Saved key errors by key id. Entries that do not have the KeyError shape are dropped. */
  private keyErrors(): Record<string, KeyError> {
    const saved = savedRecord(this.store.setting(GLOBAL_SETTINGS_SCOPE, KEY_ERRORS_SETTING)) ?? {};
    const errors: Record<string, KeyError> = {};
    for (const [id, value] of Object.entries(saved)) {
      const row = savedRecord(value);
      if (!row || !Number.isSafeInteger(row.at) || (row.at as number) < 0) continue;
      if (typeof row.status !== 'string' || typeof row.message !== 'string' || typeof row.exhausted !== 'boolean') continue;
      errors[id] = { at: row.at as number, status: row.status, message: row.message, exhausted: row.exhausted };
    }
    return errors;
  }

  private async saveKeyErrors(errors: Record<string, KeyError>): Promise<void> {
    const kept = Object.entries(errors).sort(([, a], [, b]) => b.at - a.at).slice(0, KEY_ERROR_LIMIT);
    await this.store.setSetting(GLOBAL_SETTINGS_SCOPE, KEY_ERRORS_SETTING, Object.fromEntries(kept.map(([id, error]) => [id, { at: error.at, status: error.status, message: error.message, exhausted: error.exhausted }])));
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
    const host = hostOf(url);
    let answer: ProviderFailed | undefined;
    if (plain) {
      await admit(charge, who);
      await bill(charge, who, 'plain_fetch');
      const started = Date.now();
      try {
        const page = await plain.fetch(url);
        logStep({ provider: 'plain_fetch', outcome: 'ok', started, server: who?.server, host });
        return page;
      } catch (error) {
        logStep({ provider: 'plain_fetch', outcome: 'failed', ...failureDetails(error), started, server: who?.server, host });
        if (!(error instanceof ProviderFailed)) throw error;
        if (error.siteAnswer) answer = error;
      }
    }
    if (firecrawl && pool) {
      assertWebUrl(url);
      const page = await withKey(pool, charge, who, 'firecrawl', 'firecrawl_scrape', CALL_CREDITS.firecrawl_scrape, key => firecrawl.fetch(key, url), host);
      if (page) return page;
    }
    // The site gave a definite answer, so that answer is the result. Only an outage of every provider is "unavailable".
    if (answer) throw new ToolError(siteAnswerMessage(url, answer), 'failed');
    throw new ToolError(FETCH_UNAVAILABLE, 'failed');
  }
}
