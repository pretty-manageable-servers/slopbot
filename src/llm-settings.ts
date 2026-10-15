// Fallback endpoint and degraded-mode settings for the Bot admin card. Plan: agent-wiki wiki/plans/slopbot-llm-degraded-mode.md (WP2).
import { AdminInputError } from './admin-panel.js';
import type { Json } from './domain.js';
import { DEFAULT_BREAKER, DEFAULT_STATUS_NOTE_MINUTES, LLM_DEGRADED_SETTING, LLM_FALLBACK_KEY_ID, type BreakerSettings, type FallbackEndpoint, type LlmDegradedSettings, type LlmOverride } from './llm-mode.js';
import { GLOBAL_SETTINGS_SCOPE } from './usage-cost.js';
import { WebKeySecrets } from './web-keys.js';

/** The two store calls the settings need. */
export interface SettingsStore { setting(server: string, key: string): unknown; setSetting(server: string, key: string, value: Json): void | Promise<void> }
/** The settings the admin page may see. The sealed key is left out. */
export type LlmSettingsView = Omit<LlmDegradedSettings, 'fallback'> & { fallback?: Omit<FallbackEndpoint, 'keySealed'> };
/** Result of one test request. code is a redacted error code such as PROVIDER_HTTP_503. */
export interface FallbackTest { ok: boolean; code?: string; ms: number }

const OVERRIDES: readonly LlmOverride[] = ['auto', 'normal', 'fallback', 'offline'];
// Same rule as the web key secrets in web-keys.ts, which does not export it.
const SECRET_PATTERN = /^[\x21-\x7e]{8,200}$/;
const TEST_TIMEOUT_MS = 15_000;
// The plan gives no ranges for these, so the ranges are a choice. The cooldown is at least a minute, so a model server is not woken too often.
const RANGES = { failures: [1, 100], windowSeconds: [10, 3600], cooldownSeconds: [60, 86400], maxCooldownSeconds: [60, 86400], statusNoteMinutes: [1, 1440] } as const;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const wholeIn = (value: unknown, [min, max]: readonly [number, number]): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;

function whole(value: unknown, [min, max]: readonly [number, number], label: string): number {
  const count = wholeIn(value, [min, max]);
  if (count === undefined) throw new AdminInputError(`${label} must be a whole number from ${min} to ${max}.`);
  return count;
}

function saved(store: SettingsStore): Record<string, unknown> {
  const value = store.setting(GLOBAL_SETTINGS_SCOPE, LLM_DEGRADED_SETTING);
  return isObject(value) ? value : {};
}

function baseUrl(value: unknown): string {
  const message = 'The fallback base URL must be an https URL with no login, query or fragment.';
  if (typeof value !== 'string') throw new AdminInputError(message);
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new AdminInputError(message); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new AdminInputError(message);
  return url.href.replace(/\/+$/, '');
}

/** The fields an admin sends for an endpoint. The key is handled apart. */
function endpointFields(input: Record<string, unknown>): Omit<FallbackEndpoint, 'keySealed' | 'keyLast4'> {
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (model.length < 1 || model.length > 200) throw new AdminInputError('The fallback model must be 1 to 200 characters.');
  if (typeof input.zdr !== 'boolean') throw new AdminInputError('The fallback ZDR setting must be true or false.');
  const contextTokens = whole(input.contextTokens, [2048, 1_000_000], 'Context tokens');
  const outputTokens = whole(input.outputTokens, [128, 100_000], 'Output tokens');
  if (outputTokens >= contextTokens) throw new AdminInputError('Output tokens must be less than context tokens.');
  return { baseUrl: baseUrl(input.baseUrl), model, zdr: input.zdr, contextTokens, outputTokens };
}

/** A saved endpoint that does not pass the checks is dropped, so the page falls back to no endpoint. */
function storedEndpoint(raw: Record<string, unknown>): FallbackEndpoint | undefined {
  try {
    return { ...endpointFields(raw), ...(typeof raw.keySealed === 'string' ? { keySealed: raw.keySealed } : {}), ...(typeof raw.keyLast4 === 'string' ? { keyLast4: raw.keyLast4 } : {}) };
  } catch { return undefined; }
}

/** The stored settings. Each missing or bad field takes its default. */
export function loadDegradedSettings(store: SettingsStore): LlmDegradedSettings {
  const raw = saved(store);
  const breaker = isObject(raw.breaker) ? raw.breaker : {};
  const fallback = isObject(raw.fallback) ? storedEndpoint(raw.fallback) : undefined;
  return {
    override: OVERRIDES.find(mode => mode === raw.override) ?? 'auto',
    ...(fallback ? { fallback } : {}),
    // Settings saved before the cooldown fields (probeSeconds, recoverProbes) take the defaults for them.
    breaker: breakerStored(breaker),
    statusNoteMinutes: wholeIn(raw.statusNoteMinutes, RANGES.statusNoteMinutes) ?? DEFAULT_STATUS_NOTE_MINUTES,
  };
}

function breakerStored(raw: Record<string, unknown>): BreakerSettings {
  const stored = {
    failures: wholeIn(raw.failures, RANGES.failures) ?? DEFAULT_BREAKER.failures,
    windowSeconds: wholeIn(raw.windowSeconds, RANGES.windowSeconds) ?? DEFAULT_BREAKER.windowSeconds,
    cooldownSeconds: wholeIn(raw.cooldownSeconds, RANGES.cooldownSeconds) ?? DEFAULT_BREAKER.cooldownSeconds,
    maxCooldownSeconds: wholeIn(raw.maxCooldownSeconds, RANGES.maxCooldownSeconds) ?? DEFAULT_BREAKER.maxCooldownSeconds,
  };
  // A stored pair that breaks the order is replaced by the defaults, so the breaker still has a valid cooldown.
  return stored.maxCooldownSeconds >= stored.cooldownSeconds ? stored : { ...DEFAULT_BREAKER };
}

function breakerInput(input: unknown, current: BreakerSettings): BreakerSettings {
  if (input === undefined) return current;
  if (!isObject(input)) throw new AdminInputError('Send the breaker as an object.');
  const pick = (key: keyof BreakerSettings, label: string) => input[key] === undefined ? current[key] : whole(input[key], RANGES[key], label);
  const next = { failures: pick('failures', 'Breaker failures'), windowSeconds: pick('windowSeconds', 'Breaker window'), cooldownSeconds: pick('cooldownSeconds', 'Breaker cooldown'), maxCooldownSeconds: pick('maxCooldownSeconds', 'Breaker maximum cooldown') };
  if (next.maxCooldownSeconds < next.cooldownSeconds) throw new AdminInputError('The breaker maximum cooldown must be at least the cooldown.');
  return next;
}

/** The origin of a URL, or undefined when it does not parse. */
function origin(value: string): string | undefined {
  try { return new URL(value).origin; } catch { return undefined; }
}

/** A saved key is only ever sent to the origin it was saved for. */
function sameOrigin(a: string, b: string): boolean {
  return origin(a) !== undefined && origin(a) === origin(b);
}

/** An endpoint from the request. A key that is not sent keeps the saved key, unless the origin changed. An empty key removes it. */
function fallbackInput(input: unknown, previous: FallbackEndpoint | undefined, secrets: WebKeySecrets): FallbackEndpoint {
  if (!isObject(input)) throw new AdminInputError('Send the fallback as an object.');
  const fields = endpointFields(input);
  const key = input.key;
  if (key === undefined) return previous && sameOrigin(previous.baseUrl, fields.baseUrl) ? { ...previous, ...fields } : fields;
  if (key === '') return fields;
  if (typeof key !== 'string') throw new AdminInputError('The fallback key must be text.');
  const secret = key.trim();
  if (!SECRET_PATTERN.test(secret)) throw new AdminInputError('The fallback key must be 8 to 200 printable characters with no spaces.');
  if (!secrets.enabled) throw new AdminInputError('The operator must configure WEB_KEYS_SECRET before saving the fallback key.');
  return { ...fields, keySealed: secrets.seal(secret, LLM_FALLBACK_KEY_ID), keyLast4: secret.slice(-4) };
}

/** Checks the whole request, then saves it. A refused request saves nothing. Only the key is sealed. */
export async function saveDegradedSettings(store: SettingsStore, secrets: WebKeySecrets, input: Record<string, unknown>): Promise<LlmDegradedSettings> {
  const current = loadDegradedSettings(store);
  if (input.override !== undefined && !OVERRIDES.includes(input.override as LlmOverride)) throw new AdminInputError('Choose override auto, normal, fallback or offline.');
  const next: LlmDegradedSettings = {
    override: input.override === undefined ? current.override : input.override as LlmOverride,
    breaker: breakerInput(input.breaker, current.breaker),
    statusNoteMinutes: input.statusNoteMinutes === undefined ? current.statusNoteMinutes : whole(input.statusNoteMinutes, RANGES.statusNoteMinutes, 'Status note minutes'),
    ...(input.fallback === undefined ? (current.fallback ? { fallback: current.fallback } : {}) : { fallback: fallbackInput(input.fallback, current.fallback, secrets) }),
  };
  await store.setSetting(GLOBAL_SETTINGS_SCOPE, LLM_DEGRADED_SETTING, next as unknown as Json);
  return next;
}

/** The settings without the sealed key. */
export function settingsView(settings: LlmDegradedSettings): LlmSettingsView {
  const { fallback, ...rest } = settings;
  if (!fallback) return rest;
  const { keySealed, ...visible } = fallback;
  return { ...rest, fallback: visible };
}

/** The key to send to the fallback, or undefined for none. A sealed key always wins. Without one, the primary key is reused only on the same origin, so it never leaves the gateway. */
export function openFallbackKey(settings: LlmDegradedSettings, secrets: WebKeySecrets, primary?: { baseUrl: string; apiKey: string }): string | undefined {
  const fallback = settings.fallback;
  if (!fallback) return undefined;
  if (fallback.keySealed !== undefined) return secrets.open(fallback.keySealed, LLM_FALLBACK_KEY_ID);
  return primary && sameOrigin(fallback.baseUrl, primary.baseUrl) ? primary.apiKey : undefined;
}

/** One 1-token chat request to the saved fallback, with a 15 s limit. Returns only the code, never the key or the reply. */
export async function testFallback(store: SettingsStore, secrets: WebKeySecrets, primary?: { baseUrl: string; apiKey: string }, fetcher: typeof fetch = fetch): Promise<FallbackTest> {
  const settings = loadDegradedSettings(store);
  const fallback = settings.fallback;
  if (!fallback) throw new AdminInputError('Save a fallback endpoint before you test it.');
  if (fallback.keySealed !== undefined && !secrets.enabled) throw new AdminInputError('The operator must configure WEB_KEYS_SECRET before testing the fallback key.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let key: string | undefined;
  try { key = openFallbackKey(settings, secrets, primary); }
  catch { throw new AdminInputError('The saved fallback key cannot be opened. Save the key again.'); }
  if (key !== undefined) headers.Authorization = `Bearer ${key}`;
  const started = Date.now();
  try {
    const response = await fetcher(`${fallback.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: fallback.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1, stream: false }), signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    void response.body?.cancel().catch(() => undefined);
    const ms = Date.now() - started;
    return response.ok ? { ok: true, ms } : { ok: false, code: `PROVIDER_HTTP_${response.status}`, ms };
  } catch {
    return { ok: false, code: 'PROVIDER_NETWORK', ms: Date.now() - started };
  }
}
