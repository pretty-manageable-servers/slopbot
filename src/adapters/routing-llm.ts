import { ChatCompletionsLLM } from "./chat-completions.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_OUTPUT_TOKENS } from "../context.js";
import { describeError, logError, ProviderError, RequestError } from "../errors.js";
import { DEGRADED_NOTE, isOutageError, type FallbackEndpoint, type LlmCaller, type LlmDegradedSettings, type LlmHealth, type LlmRouter } from "../llm-mode.js";
import type { Prompt, ModelEvent } from "../domain.js";
import type { LLM } from "../ports.js";
import { UNKNOWN_MODEL } from "../usage-meter.js";

/** Who may send prompts to a cloud (non-ZDR) model. Read from the saved user and server settings. */
export interface NonZdrConsent { user(user: string): boolean; server(server: string): boolean }

export interface RoutingOptions {
  consent?: NonZdrConsent;
  fetcher?: typeof fetch;
}

const NO_CONSENT: NonZdrConsent = { user: () => false, server: () => false };
const PROBE_TIMEOUT_MS = 15_000;

/** HTTP 502, 503 and 504 always mean an outage, even when the provider sent its own code. */
export function outageCode(error: unknown): string {
  if (error instanceof ProviderError && [502, 503, 504].includes(error.status)) return `PROVIDER_HTTP_${error.status}`;
  return describeError(error).code;
}

/** Reports the stream's outcome to health. Events and errors pass through unchanged. */
class TrackedLLM implements LLM {
  readonly model?: string;
  readonly outputTokenLimit?: number;
  readonly contextTokenLimit?: number;
  constructor(private readonly inner: LLM, private readonly onFailure: (code: string) => void, private readonly onFirstEvent?: () => void) {
    if (inner.model !== undefined) this.model = inner.model;
    if (inner.outputTokenLimit !== undefined) this.outputTokenLimit = inner.outputTokenLimit;
    if (inner.contextTokenLimit !== undefined) this.contextTokenLimit = inner.contextTokenLimit;
  }

  async *stream(prompt: Prompt, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    let first = true;
    try {
      for await (const event of this.inner.stream(prompt, signal)) {
        if (first) { first = false; this.onFirstEvent?.(); }
        yield event;
      }
    } catch (error) {
      const code = outageCode(error);
      if (isOutageError(code)) this.onFailure(code);
      throw error;
    }
  }
}

/** The gateway call always sends an Authorization header. A same-gateway fallback with no key must send none. */
function withoutAuthorization(fetcher: typeof fetch): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
    delete headers.Authorization;
    return fetcher(url, { ...init, headers });
  }) as typeof fetch;
}

/** Picks the model that may answer a caller now. Normal mode always uses the primary model. */
export class RoutingLLM implements LlmRouter {
  private readonly primary: LLM;
  private readonly consent: NonZdrConsent;
  private fallback: { key: string; llm: LLM | undefined } | undefined;

  constructor(primary: LLM, private readonly health: LlmHealth, private readonly settings: () => LlmDegradedSettings | undefined, private readonly openKey: (endpoint: FallbackEndpoint) => string | undefined, private readonly options: RoutingOptions = {}) {
    this.consent = options.consent ?? NO_CONSENT;
    this.primary = new TrackedLLM(primary, code => this.health.recordFailure(code), () => this.health.recordSuccess());
  }

  select(who: LlmCaller | undefined): LLM | undefined {
    const state = this.health.state();
    if (state.mode === "normal") return this.primary;
    if (state.mode === "offline") return undefined;
    const endpoint = this.settings()?.fallback;
    if (!endpoint) return undefined;
    if (!endpoint.zdr && !this.cloudAllowed(who)) return undefined;
    return this.fallbackLLM(endpoint);
  }

  // A cloud model may answer only users who opted in, in private chats or in servers that allow it.
  private cloudAllowed(who: LlmCaller | undefined): boolean {
    if (!who) return false;
    return this.consent.user(who.user) && (who.private || this.consent.server(who.server));
  }

  // Built again only when the endpoint or its sealed key changes. The key is opened at build time.
  private fallbackLLM(endpoint: FallbackEndpoint): LLM | undefined {
    const key = JSON.stringify([endpoint.baseUrl, endpoint.model, endpoint.contextTokens, endpoint.outputTokens, endpoint.keySealed ?? '']);
    if (this.fallback?.key === key) return this.fallback.llm;
    let llm: LLM | undefined;
    try {
      const apiKey = this.openKey(endpoint);
      const fetcher = apiKey === undefined ? withoutAuthorization(this.options.fetcher ?? fetch) : this.options.fetcher;
      llm = new TrackedLLM(new ChatCompletionsLLM({
        baseUrl: endpoint.baseUrl, apiKey: apiKey ?? '', model: endpoint.model,
        outputTokens: endpoint.outputTokens, contextTokens: endpoint.contextTokens,
      }, fetcher), code => this.health.recordFailure(code));
    } catch (error) {
      logError("llm_fallback_unavailable", error, { stage: "llm routing" });
    }
    this.fallback = { key, llm };
    return llm;
  }
}

/** The LLM the adapters hold. Each call asks the router for the model that may answer now, with no caller. */
export class DynamicLLM implements LLM {
  constructor(private readonly router: LlmRouter, private readonly primary: LLM) {}
  get model(): string { return this.current().model ?? UNKNOWN_MODEL; }
  get outputTokenLimit(): number { return this.current().outputTokenLimit ?? DEFAULT_OUTPUT_TOKENS; }
  get contextTokenLimit(): number { return this.current().contextTokenLimit ?? DEFAULT_CONTEXT_TOKENS; }

  async *stream(prompt: Prompt, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const llm = this.router.select(undefined);
    if (!llm) throw new RequestError("LLM_OFFLINE", DEGRADED_NOTE, "Wait for the model service, or ask a team admin to set a backup model.");
    yield* llm.stream(prompt, signal);
  }

  private current(): LLM { return this.router.select(undefined) ?? this.primary; }
}

/** One 1-token chat request to the primary model. True when the gateway answers 2xx. Never throws. */
export async function probePrimary(baseUrl: string, apiKey: string, model: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    void response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}
