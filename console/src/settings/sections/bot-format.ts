// The admin Bot settings' rules, kept out of the view: the LLM request body (the backup key is kept, set or
// cleared), the range checks before a save, the model state line, and the web key checks and labels. The bot checks
// the same ranges again; these stop a bad save before it leaves the browser.
import type { Breaker, KeyedProvider, Llm, LlmFallback, LlmOverride, WebKey } from "../../api-types";

export const PROVIDER_NAMES: Record<KeyedProvider, string> = { tavily: "Tavily", firecrawl: "Firecrawl" };
export const LLM_MODE_TEXT: Record<Llm["state"]["mode"], string> = { normal: "Normal", fallback: "Backup model", offline: "Offline" };

const RANGE = {
  failures: [1, 100],
  windowSeconds: [10, 3600],
  cooldownSeconds: [60, 86400],
  maxCooldownSeconds: [60, 86400],
  statusNoteMinutes: [1, 1440],
  contextTokens: [2048, 1000000],
  outputTokens: [128, 100000],
  cap: [1, 100000],
} as const;
const BASE_URL_MAX = 300;
const MODEL_MAX = 200;
const SECRET_PATTERN = /^[!-~]{8,200}$/;

const inRange = (value: number, [min, max]: readonly [number, number]) => Number.isInteger(value) && value >= min && value <= max;
const isUrl = (text: string) => { try { new URL(text); return true; } catch { return false; } };

/** The Model form as it is typed. The key is the field's text; clearKey asks to remove the saved key on save. */
export interface LlmForm {
  override: LlmOverride;
  breaker: Breaker;
  statusNoteMinutes: number;
  backup: { baseUrl: string; model: string; zdr: boolean; contextTokens: number; outputTokens: number };
  key: string;
  clearKey: boolean;
}

/** What Save posts to /api/admin/llm. The backup model is sent only with a base URL; the key only when set or cleared. */
export interface LlmBody {
  override: LlmOverride;
  breaker: Breaker;
  statusNoteMinutes: number;
  fallback?: Omit<LlmFallback, "keyLast4"> & { key?: string };
}

/** The form for the saved settings. Numbers that are not saved yet are NaN, which shows an empty field. */
export function llmFormFrom(llm: Llm): LlmForm {
  const { settings: s } = llm;
  const fb = s.fallback;
  return {
    override: s.override,
    breaker: { ...s.breaker },
    statusNoteMinutes: s.statusNoteMinutes,
    backup: {
      baseUrl: fb?.baseUrl ?? "",
      model: fb?.model ?? "",
      zdr: fb?.zdr ?? false,
      contextTokens: fb?.contextTokens ?? Number.NaN,
      outputTokens: fb?.outputTokens ?? Number.NaN,
    },
    key: "",
    clearKey: false,
  };
}

/** The first problem with the form, as a sentence for the user, or null when Save may go ahead. */
export function llmProblem(form: LlmForm): string | null {
  const { breaker: b, backup: fb } = form;
  if (!inRange(b.failures, RANGE.failures)) return "Failures must be a whole number from 1 to 100.";
  if (!inRange(b.windowSeconds, RANGE.windowSeconds)) return "Window must be a whole number of seconds from 10 to 3600.";
  if (!inRange(b.cooldownSeconds, RANGE.cooldownSeconds)) return "Cooldown must be a whole number of seconds from 60 to 86400.";
  if (!inRange(b.maxCooldownSeconds, RANGE.maxCooldownSeconds)) return "Max cooldown must be a whole number of seconds from 60 to 86400.";
  if (b.maxCooldownSeconds < b.cooldownSeconds) return "Max cooldown must be at least the cooldown.";
  if (!inRange(form.statusNoteMinutes, RANGE.statusNoteMinutes)) return "The status note must be every 1 to 1440 minutes.";
  const baseUrl = fb.baseUrl.trim();
  if (!baseUrl) return form.key || form.clearKey ? "Enter a base URL first. Without one the backup model is not saved." : null;
  if (baseUrl.length > BASE_URL_MAX || !isUrl(baseUrl)) return "The base URL must be a full URL, for example https://models.example.com/v1.";
  if (fb.model.trim().length < 1 || fb.model.trim().length > MODEL_MAX) return "The model name is 1 to 200 characters.";
  if (!inRange(fb.contextTokens, RANGE.contextTokens)) return "Context tokens must be a whole number from 2048 to 1000000.";
  if (!inRange(fb.outputTokens, RANGE.outputTokens)) return "Output tokens must be a whole number from 128 to 100000.";
  if (fb.outputTokens >= fb.contextTokens) return "Output tokens must be less than context tokens.";
  if (form.key.trim() && !SECRET_PATTERN.test(form.key.trim())) return "The API key is 8 to 200 characters with no spaces.";
  return null;
}

/** The POST body for a valid form. Without a base URL no backup model is sent, so the saved one is kept. */
export function llmBody(form: LlmForm): LlmBody {
  const body: LlmBody = {
    override: form.override,
    breaker: {
      failures: form.breaker.failures,
      windowSeconds: form.breaker.windowSeconds,
      cooldownSeconds: form.breaker.cooldownSeconds,
      maxCooldownSeconds: form.breaker.maxCooldownSeconds,
    },
    statusNoteMinutes: form.statusNoteMinutes,
  };
  const baseUrl = form.backup.baseUrl.trim();
  if (!baseUrl) return body;
  const fallback: NonNullable<LlmBody["fallback"]> = {
    baseUrl,
    model: form.backup.model.trim(),
    zdr: form.backup.zdr,
    contextTokens: form.backup.contextTokens,
    outputTokens: form.backup.outputTokens,
  };
  const key = form.key.trim();
  if (key) fallback.key = key;
  else if (form.clearKey) fallback.key = "";
  return { ...body, fallback };
}

/** "Mode: Backup model since <time>, set by the circuit breaker. Last error: <text>." */
export function llmStateText(state: Llm["state"]): string {
  const origin = state.source === "override" ? "set by an admin" : "set by the circuit breaker";
  const last = state.lastError ? ` Last error: ${state.lastError}.` : "";
  return `Mode: ${LLM_MODE_TEXT[state.mode]} since ${new Date(state.since).toLocaleString()}, ${origin}.${last}`;
}

/** The backup key line under the key field. */
export function backupKeyText(fallback: LlmFallback | undefined): string {
  return fallback?.keyLast4
    ? `A key ending in ${fallback.keyLast4} is saved. Type a new key to replace it. The key is never sent back to the browser.`
    : "No backup key is saved. The key is never sent back to the browser.";
}

/** A web key secret: 8 to 200 printable characters, no spaces. */
export function secretProblem(secret: string): string | null {
  return SECRET_PATTERN.test(secret) ? null : "The key is 8 to 200 printable characters with no spaces.";
}

/** The body for POST /api/admin/web-keys/add. The label is trimmed, as the old console did. */
export function addKeyBody(input: { provider: KeyedProvider; label: string; secret: string }) {
  return { provider: input.provider, label: input.label.trim(), secret: input.secret };
}

export function capsProblem(caps: Record<KeyedProvider, number>): string | null {
  return Object.values(caps).every((cap) => inRange(cap, RANGE.cap)) ? null : "Each cap is a whole number of credits from 1 to 100000.";
}

/** Short time since a past moment, for example "5 min ago". */
export function agoText(ms: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** A key's last error as one line: "429 · rate limited · 5 min ago". */
export function keyErrorText(error: NonNullable<WebKey["lastError"]>, now = Date.now()): string {
  return `${error.status} · ${error.message} · ${agoText(error.at, now)}`;
}
