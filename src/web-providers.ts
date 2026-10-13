// Shared contract for web search and web fetch providers.
// SearXNG and plain fetch are free. Tavily and Firecrawl use team keys from the admin panel.
import type { SearchHit } from './web-search.js';

/** One step in a search or fetch chain. Each step has a fixed cost on the user's 5h and weekly limits. */
export type WebProvider = 'searxng' | 'tavily' | 'firecrawl_search' | 'plain_fetch' | 'firecrawl_scrape';
/** A service that needs a team key. */
export type KeyedProvider = 'tavily' | 'firecrawl';
export const KEYED_PROVIDERS: readonly KeyedProvider[] = ['tavily', 'firecrawl'];

/** Default cost in micro-dollars for each call, charged to the user. Admins can override with the WEB_COSTS_SETTING. */
export const WEB_COSTS_MICROS: Readonly<Record<WebProvider, number>> = {
  searxng: 1_000, plain_fetch: 1_000, tavily: 10_000, firecrawl_search: 10_000, firecrawl_scrape: 5_000,
};
/** Global setting key. Value: partial Record<WebProvider, number> in micro-dollars. */
export const WEB_COSTS_SETTING = 'web_costs_micros';
/** Global setting key. Value: partial Record<KeyedProvider, number>, the monthly credit cap for each key. */
export const KEY_CAPS_SETTING = 'web_key_caps';
/** Default monthly credit cap for each key. Both free plans give 1,000 credits a month; keep a margin. */
export const DEFAULT_KEY_CAPS: Readonly<Record<KeyedProvider, number>> = { tavily: 950, firecrawl: 950 };
/** Provider credits used by one call. Tavily basic search: 1. Firecrawl search: 2 per 10 results. Firecrawl basic scrape: 1. */
export const CALL_CREDITS = { tavily: 1, firecrawl_search: 2, firecrawl_scrape: 1 } as const;

/** Most characters of page text that web_fetch gives to the model. */
export const FETCH_TEXT_LIMIT = 8_000;

/**
 * A provider could not answer. The chain moves to the next step.
 * keyExhausted: the key is out of credits (Tavily 432, Firecrawl 402); the pool marks it for this month.
 * Any other thrown error from a provider also counts as a failure.
 * status: the HTTP status as text (for example "401"), or "network", "timeout", "bad_response", "too_large", "empty". Never holds a secret.
 */
export class ProviderFailed extends Error {
  override name = 'ProviderFailed';
  readonly status?: string | undefined;
  constructor(readonly provider: WebProvider, message: string, readonly keyExhausted = false, options?: ErrorOptions & { status?: string }) {
    super(message, options);
    this.status = options?.status;
  }
}

/** A decrypted key. Lives only in memory, for one call. Never log or return secret. last4 is for logs and display. */
export interface ProviderKey { id: string; provider: KeyedProvider; secret: string; last4?: string }

/** Picks and counts team keys. Implemented over the store, which makes reserve atomic. */
export interface ProviderKeyPool {
  /** Adds credits to the key with the most credits left this month, under its cap. undefined when no key has room. */
  reserve(provider: KeyedProvider, credits: number, now?: number): Promise<ProviderKey | undefined>;
  /** Marks a key out of credits until the month ends. */
  exhaust(id: string, now?: number): Promise<void>;
  /** Saves the last error of a key, for diagnostics. Optional: a pool without it keeps no error history. */
  recordError?(id: string, error: KeyError): Promise<void>;
  /** Removes the saved last error of a key after a success. Does nothing when the key has none. */
  clearError?(id: string): Promise<void>;
}

/** Search with a team key. Throws ProviderFailed on failure. An empty array means no match. */
export interface KeyedSearch { search(key: ProviderKey, query: string, limit: number): Promise<readonly SearchHit[]> }

/** Page text for the model. text is at most FETCH_TEXT_LIMIT characters; truncated is true when it was cut. */
export interface PageText { url: string; title: string; text: string; truncated: boolean }
/** Free page fetch. Throws ProviderFailed when the page cannot be read or gives almost no text. */
export interface WebFetch { fetch(url: string): Promise<PageText> }
/** Page fetch with a team key. Throws ProviderFailed on failure. */
export interface KeyedFetch { fetch(key: ProviderKey, url: string): Promise<PageText> }

/** Charges one call to the user's 5h and weekly limits. check throws UserLimitError when the user is at the limit. */
export interface WebCharge {
  check(server: string, user: string): Promise<void>;
  charge(server: string, user: string, provider: WebProvider): Promise<void>;
}

/** Month bucket for key usage, in UTC, for example "2026-10". */
export function usageMonth(now = Date.now()): string { return new Date(now).toISOString().slice(0, 7); }

/** Stored key row. secretEncrypted is AES-256-GCM sealed with WEB_KEYS_SECRET. last4 is for display. */
export interface ProviderKeyRow { id: string; provider: KeyedProvider; owner: string; label: string; last4: string; secretEncrypted: string; createdAt: number }
/** Use of one key in one month. */
export interface ProviderKeyUsage { keyId: string; month: string; used: number; exhausted: boolean }

/** Store methods for team keys and their monthly use. SQLite and Postgres both implement them. */
export interface ProviderKeyStore {
  listProviderKeys(): Promise<ProviderKeyRow[]>;
  addProviderKey(row: ProviderKeyRow): Promise<void>;
  /** Removes the key and its usage rows. False when no key has this id. */
  deleteProviderKey(id: string): Promise<boolean>;
  /**
   * In one transaction: picks the key of this provider with the lowest used count this month that is not exhausted
   * and has used + credits <= cap, adds credits, and returns its row. undefined when no key has room.
   */
  reserveProviderCredits(provider: KeyedProvider, month: string, credits: number, cap: number): Promise<ProviderKeyRow | undefined>;
  exhaustProviderKey(id: string, month: string): Promise<void>;
  /** Clears the exhausted flag of a key for the month. Used credits stay. */
  resetProviderKey(id: string, month: string): Promise<void>;
  providerKeyUsage(month: string): Promise<ProviderKeyUsage[]>;
}

/** Global setting key. Value: Record<keyId, KeyError>, the last error of each team key. Diagnostics only. */
export const KEY_ERRORS_SETTING = 'web_key_errors';
/** Last error of one key. status is the HTTP status as text, or "network", "timeout", "bad_response". message never holds a secret. */
export interface KeyError { at: number; status: string; message: string; exhausted: boolean }
