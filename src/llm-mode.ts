// Shared contract for LLM degraded mode. Plan: agent-wiki wiki/plans/slopbot-llm-degraded-mode.md.
import type { LLM } from './ports.js';

export type LlmMode = 'normal' | 'fallback' | 'offline';
export type LlmOverride = 'auto' | LlmMode;

export const LLM_DEGRADED_SETTING = 'llm_degraded';
// AAD for sealing the fallback key inside the llm_degraded setting. Not a provider_keys row id.
export const LLM_FALLBACK_KEY_ID = 'llm-fallback';
export const USER_NON_ZDR_SETTING = 'user_non_zdr';
export const SERVER_NON_ZDR_SETTING = 'allow_non_zdr';

export interface FallbackEndpoint {
  baseUrl: string;
  model: string;
  // false means a cloud model without zero data retention.
  zdr: boolean;
  contextTokens: number;
  outputTokens: number;
  // Never sent to the browser.
  keySealed?: string;
  keyLast4?: string;
}

export interface BreakerSettings { failures: number; windowSeconds: number; cooldownSeconds: number; maxCooldownSeconds: number }
// No probes. The breaker waits cooldownSeconds, then lets one real request try the primary. Each failed try doubles the wait, up to maxCooldownSeconds.
export const DEFAULT_BREAKER: BreakerSettings = { failures: 5, windowSeconds: 60, cooldownSeconds: 600, maxCooldownSeconds: 7200 };
export const DEFAULT_STATUS_NOTE_MINUTES = 30;

export interface LlmDegradedSettings {
  override: LlmOverride;
  fallback?: FallbackEndpoint;
  breaker: BreakerSettings;
  statusNoteMinutes: number;
}

export interface LlmModeState {
  mode: LlmMode;
  source: 'override' | 'breaker';
  since: number;
  lastError?: string;
}

export interface LlmHealth {
  state(): LlmModeState;
  recordFailure(code: string): void;
  recordSuccess(): void;
  onChange(listener: (state: LlmModeState) => void): () => void;
  // The half-open trial. Only real user requests make it. Slopbot never sends its own test request.
  // trialDue() does not claim the slot. claimTrial() claims it. endTrial() releases it; code is the redacted error for 'outage'.
  trialDue(): boolean;
  claimTrial(): boolean;
  endTrial(result: 'success' | 'outage' | 'other', code?: string): void;
}

export interface LlmCaller { user: string; server: string; private: boolean }

export interface LlmRouter {
  // undefined: no model may answer this caller now (offline, or a non-ZDR fallback without consent).
  select(who: LlmCaller | undefined): LLM | undefined;
}

// REQUEST_TIMEOUT is a hung gateway; REQUEST_ABORTED is a user stop and stays out. HTTP 500 stays out because one bad request can cause it.
// PROVIDER_MODEL_NOT_FOUND counts because a removed primary model is how a model outage shows on the gateway.
const OUTAGE_CODES = new Set(['PROVIDER_NETWORK', 'PROVIDER_HTTP_502', 'PROVIDER_HTTP_503', 'PROVIDER_HTTP_504', 'PROVIDER_MODEL_NOT_FOUND', 'PROVIDER_STREAM_ERROR', 'PROVIDER_STREAM_INTERRUPTED', 'REQUEST_TIMEOUT']);

// Only errors that mean the service is down. Auth, budget, rate limit and request errors would trip the breaker for the wrong reason.
export function isOutageError(code: string): boolean {
  return OUTAGE_CODES.has(code);
}

export const DEGRADED_NOTE = 'Slopbot is running at reduced capacity because its model service is down. Slash commands still work. Messages sent now will not be answered later.';
export const FALLBACK_NOTE = 'Slopbot is running at reduced capacity on a backup model. Answers can be weaker.';
