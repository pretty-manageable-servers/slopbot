import { ModelAliases } from "./model-aliases.js";
import { randomUUID } from "node:crypto";
import { requestTimings } from "../request-timing.js";
import type { Json, Message, Prompt } from "../domain.js";
import type { Classifier, ParticipationDecision } from "../participation.js";
import type { Store } from "../ports.js";
import { ProviderError } from "./chat-completions.js";

import { decisionQuestions as questions } from "../participation-prompts.js";

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid decision probability");
  return value;
}

export class DecisionClassifier implements Classifier {
  private readonly aliases: ModelAliases;
  private unsupported = false;
  constructor(
    private readonly options: { baseUrl: string; apiKey: string; model: string },
    private readonly store: Store, private readonly fetcher: typeof fetch = fetch,
    private readonly fallback?: Classifier,
  ) { this.aliases = new ModelAliases(options.baseUrl); }

  async classify(message: Message, context: readonly Message[]): Promise<ParticipationDecision> {
    if (this.unsupported && this.fallback) return this.fallback.classify(message, context);
    const state = JSON.stringify({ preceding: context, CURRENT: message });
    const prompt: Prompt = {
      prefixVersion: "decisions-v2", prefix: [{ role: "system", content: JSON.stringify(questions) }],
      history: [], inputs: [{ role: "user", content: state }],
    };
    const runId = randomUUID();
    await this.store.startRun(runId, message, prompt);
    await this.store.recordSources(runId, message.server, [message.id, ...context.map(item => item.id)]);
    try {
      const response = await this.aliases.request(this.options.model, model => requestTimings.wait("decision endpoint headers", () => this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/decisions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(15000),
      })));
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError(response.status); }
      const raw = await requestTimings.wait("decision response body", () => response.json()) as { answers?: { addressed?: { value?: unknown }; respond?: { value?: unknown }; funny?: { value?: unknown } } };
      await this.store.appendEvent(runId, 0, { kind: "opaque", payload: raw as Json });
      const direct = probability(raw.answers?.addressed?.value);
      const useful = probability(raw.answers?.respond?.value);
      const addressed = direct >= 0.65;
      const respond = addressed ? useful >= 0.5 : useful >= 0.9;
      const emoji = raw.answers?.funny ? (probability(raw.answers.funny.value) >= 0.9 ? "😂" : undefined) : undefined;
      const decision = { respond, addressed, ...(emoji ? { emoji } : {}), reason: `addressed=${direct.toFixed(3)},respond=${useful.toFixed(3)}` };
      await this.store.complete(runId, undefined, [], JSON.stringify(decision));
      return decision;
    } catch (error) {
      await this.store.fail(runId, "DecisionError");
      if (error instanceof ProviderError && error.status === 404 && this.fallback) {
        this.unsupported = true;
        console.warn("Decision endpoint unavailable; using the chat participation classifier.");
        return this.fallback.classify(message, context);
      }
      throw error;
    }
  }
}
