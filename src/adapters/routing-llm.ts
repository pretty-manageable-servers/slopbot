import { ChatCompletionsLLM } from "./chat-completions.js";
import { describeError, logError, ProviderError } from "../errors.js";
import { isOutageError, type FallbackEndpoint, type LlmCaller, type LlmDegradedSettings, type LlmHealth, type LlmRouter } from "../llm-mode.js";
import type { Prompt, ModelEvent } from "../domain.js";
import type { LLM } from "../ports.js";

/** Who may send prompts to a cloud (non-ZDR) model. Read from the saved user and server settings. */
export interface NonZdrConsent { user(user: string): boolean; server(server: string): boolean }

export interface RoutingOptions {
  consent?: NonZdrConsent;
  fetcher?: typeof fetch;
}

const NO_CONSENT: NonZdrConsent = { user: () => false, server: () => false };

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

/** Picks the model that may answer a caller now. Normal mode always uses the primary model. */
export class RoutingLLM implements LlmRouter {
  private readonly primary: LLM;
  private readonly consent: NonZdrConsent;
  private fallback: { key: string; llm: LLM | undefined } | undefined;

  constructor(primary: LLM, private readonly health: LlmHealth, private readonly settings: () => LlmDegradedSettings | undefined, private readonly openKey: (sealed: string) => string, private readonly options: RoutingOptions = {}) {
    this.consent = options.consent ?? NO_CONSENT;
    this.primary = new TrackedLLM(primary, code => this.health.recordFailure(code), () => this.health.recordSuccess());
  }

  select(who: LlmCaller | undefined): LLM | undefined {
    const state = this.health.state();
    if (state.mode === "normal") return this.primary;
    if (state.mode === "offline") return undefined;
    const endpoint = this.settings()?.fallback;
    if (!endpoint?.keySealed) return undefined;
    if (!endpoint.zdr && !this.cloudAllowed(who)) return undefined;
    return this.fallbackLLM(endpoint, endpoint.keySealed);
  }

  // A cloud model may answer only users who opted in, in private chats or in servers that allow it.
  private cloudAllowed(who: LlmCaller | undefined): boolean {
    if (!who) return false;
    return this.consent.user(who.user) && (who.private || this.consent.server(who.server));
  }

  // Built again only when the endpoint or its key changes. The key is opened at build time.
  private fallbackLLM(endpoint: FallbackEndpoint, sealed: string): LLM | undefined {
    const key = JSON.stringify([endpoint.baseUrl, endpoint.model, endpoint.contextTokens, endpoint.outputTokens, sealed]);
    if (this.fallback?.key === key) return this.fallback.llm;
    let llm: LLM | undefined;
    try {
      llm = new TrackedLLM(new ChatCompletionsLLM({
        baseUrl: endpoint.baseUrl, apiKey: this.openKey(sealed), model: endpoint.model,
        outputTokens: endpoint.outputTokens, contextTokens: endpoint.contextTokens,
      }, this.options.fetcher), code => this.health.recordFailure(code));
    } catch (error) {
      logError("llm_fallback_unavailable", error, { stage: "llm routing" });
    }
    this.fallback = { key, llm };
    return llm;
  }
}
