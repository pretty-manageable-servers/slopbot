// Shared contract for LLM degraded mode. Plan: agent-wiki wiki/plans/slopbot-llm-degraded-mode.md.
import type { LLM } from './ports.js';

export type LlmMode = 'normal' | 'fallback' | 'offline';
export type LlmOverride = 'auto' | LlmMode;

export const LLM_DEGRADED_SETTING = 'llm_degraded';
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

export interface BreakerSettings { failures: number; windowSeconds: number; probeSeconds: number; recoverProbes: number }
export const DEFAULT_BREAKER: BreakerSettings = { failures: 5, windowSeconds: 60, probeSeconds: 30, recoverProbes: 2 };
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
}

export interface LlmCaller { user: string; server: string; private: boolean }

export interface LlmRouter {
  // undefined: no model may answer this caller now (offline, or a non-ZDR fallback without consent).
  select(who: LlmCaller | undefined): LLM | undefined;
}

const OUTAGE_CODES = new Set(['PROVIDER_NETWORK', 'PROVIDER_HTTP_502', 'PROVIDER_HTTP_503', 'PROVIDER_HTTP_504', 'PROVIDER_MODEL_NOT_FOUND', 'PROVIDER_STREAM_ERROR']);

// Only errors that mean the service is down. Auth, budget, rate limit and request errors would trip the breaker for the wrong reason.
export function isOutageError(code: string): boolean {
  return OUTAGE_CODES.has(code) || code.startsWith('PROVIDER_STREAM_ERROR');
}

export const DEGRADED_NOTE = 'Slopbot is running at reduced capacity because its model service is down. Slash commands still work. Messages sent now will not be answered later.';
export const FALLBACK_NOTE = 'Slopbot is running at reduced capacity on a backup model. Answers can be weaker.';
