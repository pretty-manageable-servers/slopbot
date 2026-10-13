import { ModelAliases } from "./model-aliases.js";
import type { Embeddings } from "../memory.js";
import { requestTimings } from "../request-timing.js";
import { providerError } from "../errors.js";
import { ByteTokenCounter } from "../context.js";
import type { Attribution, UsageMeter } from "../usage-meter.js";

/** The model id that prices an embedding call. PMServers bills the Gemma model under its public name. */
export function embeddingPriceModel(baseUrl: string, model: string): string {
  return new URL(baseUrl).hostname === "api.pmservers.org" && model === "llama.cpp/embeddinggemma-2" ? "stratus" : model;
}

export class ProviderEmbeddings implements Embeddings {
  private readonly aliases: ModelAliases;
  private nextRequestAt = 0;
  private usage?: UsageMeter;
  constructor(
    private readonly baseUrl: string, private readonly key: string,
    readonly model = "llama.cpp/embeddinggemma-2", private readonly fetcher: typeof fetch = fetch,
  ) { this.aliases = new ModelAliases(baseUrl); }

  /** Charges embedding calls made through this adapter. Set once the store and meter exist. */
  attachUsage(usage: UsageMeter): void { this.usage = usage; }

  async embed(text: string): Promise<readonly number[]> {
    return (await this.embedWithUsage(text)).vector;
  }

  async embedWithUsage(text: string, who?: Attribution): Promise<{ vector: readonly number[]; tokens: number | null }> {
    // PMServers uses a different alias for the same Gemma model. Keep the index
    // identity stable so switching gateways does not re-embed saved memories.
    const model = embeddingPriceModel(this.baseUrl, this.model);
    let response!: Response;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = Math.max(0, this.nextRequestAt - Date.now());
      this.nextRequestAt = Date.now() + wait + 1500;
      if (wait) await requestTimings.wait("embedding throttle/backoff", () => new Promise(resolve => setTimeout(resolve, wait)));
      response = await this.aliases.request(model, wireModel => requestTimings.wait("embedding headers", () => this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: wireModel, input: text.slice(0, 8000) }),
      signal: AbortSignal.timeout(15000),
    })));
      if (response.status !== 429 || attempt === 2) break;
      const retry = response.headers.get("retry-after");
      const delay = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000 : 60000;
      await response.body?.cancel();
      this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + Math.min(120000, Math.max(1500, delay)));
    }
    if (!response.ok) { throw await providerError(response); }
    const body = await requestTimings.wait("embedding body", () => response.json()) as { data?: { embedding?: unknown }[]; usage?: { prompt_tokens?: unknown; total_tokens?: unknown } };
    const vector = body.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length || !vector.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("Invalid embedding response");
    }
    const reported = body.usage?.prompt_tokens ?? body.usage?.total_tokens;
    const tokens = typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0 ? reported : null;
    // An embedding has no completion, so it is priced as input. Without usage, the sent text is estimated.
    await this.usage?.record(who, model, { prompt_tokens: tokens ?? new ByteTokenCounter().count([{ role: "user", content: text.slice(0, 8000) }]) });
    return { vector: vector as number[], tokens };
  }
}
