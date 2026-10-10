import type { Embeddings } from "../memory.js";
import { ProviderError } from "./chat-completions.js";

export class ProviderEmbeddings implements Embeddings {
  constructor(
    private readonly baseUrl: string, private readonly key: string,
    readonly model = "llama.cpp/embeddinggemma-2", private readonly fetcher: typeof fetch = fetch,
  ) {}

  async embed(text: string): Promise<readonly number[]> {
    return (await this.embedWithUsage(text)).vector;
  }

  async embedWithUsage(text: string): Promise<{ vector: readonly number[]; tokens: number | null }> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: this.model, input: text.slice(0, 8000) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderError(response.status); }
    const body = await response.json() as { data?: { embedding?: unknown }[]; usage?: { prompt_tokens?: unknown; total_tokens?: unknown } };
    const vector = body.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length || !vector.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("Invalid embedding response");
    }
    const tokens = body.usage?.prompt_tokens ?? body.usage?.total_tokens;
    return { vector: vector as number[], tokens: typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null };
  }
}
