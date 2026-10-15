import { errorSummary, logError } from "../errors.js";
import { ModelAliases } from "./model-aliases.js";
import { randomUUID } from "node:crypto";
import { requestTimings } from "../request-timing.js";
import type { Json, Message, Prompt } from "../domain.js";
import type { Classifier, ParticipationDecision } from "../participation.js";
import type { Store } from "../ports.js";
import { ProviderError, providerError } from "../errors.js";
import { attribution, DECISION_OUTPUT_TOKENS, promptEstimate, type UsageMeter } from "../usage-meter.js";

import { decisionQuestions as questions } from "../participation-prompts.js";
import { defaultDecisionThresholds, scoredDecision } from '../participation-history.js';
import { classifierInput } from '../classifier-input.js';

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid decision probability");
  return value;
}

export class DecisionClassifier implements Classifier {
  private readonly aliases: ModelAliases;
  private unsupported = false;
  constructor(
    private readonly options: { baseUrl: string; apiKey: string; model: string; usage?: UsageMeter },
    private readonly store: Store, private readonly fetcher: typeof fetch = fetch,
    private readonly fallback?: Classifier,
  ) { this.aliases = new ModelAliases(options.baseUrl); }

  async classify(message: Message, context: readonly Message[]): Promise<ParticipationDecision> {
    if (this.unsupported && this.fallback) return this.fallback.classify(message, context);

    const { state, preceding } = classifierInput(message, context);
    const prompt: Prompt = {
      prefixVersion: "systemone-v4", prefix: [{ role: "system", content: JSON.stringify(questions) }],
      history: [], inputs: [{ role: "user", content: state }],
    };
    const runId = randomUUID();
    await this.store.startRun(runId, message, prompt);
    await this.store.recordSources(runId, message.server, [message.id, ...preceding.map(item => item.id)]);
    try {
      const response = await this.aliases.request(this.options.model, model => requestTimings.wait("decision endpoint headers", () => this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/systemone`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(15000),
      })));
      if (!response.ok) { throw await providerError(response); }
      const raw = await requestTimings.wait("decision response body", () => response.json()) as { answers?: { addressed?: { probabilities?: { yes?: unknown; no?: unknown } }; respond?: { probabilities?: { yes?: unknown; no?: unknown } }; funny?: { probabilities?: { yes?: unknown; no?: unknown } } } };
      // The endpoint reports no usage, so the answer is charged as an estimate of the input and a fixed answer size.
      await this.options.usage?.record(attribution(message), this.options.model, promptEstimate(prompt, DECISION_OUTPUT_TOKENS));
      await this.store.appendEvent(runId, 0, { kind: "opaque", payload: raw as Json });
      const direct = probability(raw.answers?.addressed?.probabilities?.yes);
      const useful = probability(raw.answers?.respond?.probabilities?.yes);
      const funny = raw.answers?.funny ? probability(raw.answers.funny.probabilities?.yes) : undefined;
      const decision = scoredDecision({ addressed: direct, respond: useful, ...(funny !== undefined ? { funny } : {}) }, defaultDecisionThresholds);
      await this.store.complete(runId, undefined, [], JSON.stringify(decision));
      return decision;
    } catch (error) {
      await this.store.fail(runId, errorSummary(error));
      if (error instanceof ProviderError && error.status === 404 && this.fallback) {
        this.unsupported = true;
        logError("decision_endpoint_unavailable_using_chat_classifier", error, { stage: "participation classification", runId }, true);
        return this.fallback.classify(message, context);
      }
      throw error;
    }
  }
}
