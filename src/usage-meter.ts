import type { Config } from "./config.js";
import { ByteTokenCounter, DEFAULT_OUTPUT_TOKENS } from "./context.js";
import { promptItems, type Json, type Message, type ModelEvent, type Prompt } from "./domain.js";
import { embeddingPriceModel } from "./adapters/embeddings.js";
import { logError } from "./errors.js";
import type { LLM, Store } from "./ports.js";
import { UserLimiter, type UserLimitStore } from "./user-limiter.js";
import { activePrices, GLOBAL_SETTINGS_SCOPE, usageCostMicros, usageTokens, type ModelPrice, type PriceTable } from "./usage-cost.js";

/** The user who pays for a model call: the author of the message that caused it. */
export interface Attribution { server: string; user: string }

// Used when an LLM does not name its model. Such calls get the fallback price.
export const UNKNOWN_MODEL = "unknown-model";
// The decision endpoint returns probabilities, not text. Its answer size is estimated at this many tokens.
export const DECISION_OUTPUT_TOKENS = 256;

const counter = new ByteTokenCounter();

/** Bot messages have no payer. Returns undefined for them, so their model calls are not charged. */
export function attribution(message: Message): Attribution | undefined {
  return message.isBot ? undefined : { server: message.server, user: message.author };
}

/** Estimated usage for a call whose provider sent none: the input estimate plus the full output budget. */
export function promptEstimate(prompt: Prompt, outputTokens: number): Json {
  const tools = prompt.tools?.length ? counter.count([{ role: "system", content: JSON.stringify(prompt.tools) }]) : 0;
  return { prompt_tokens: counter.count(promptItems(prompt)) + tools, completion_tokens: prompt.maxOutputTokens ?? outputTokens };
}

export type UsageStore = UserLimitStore & Pick<Store, "addTokenTotals">;

/** Charges model calls to users. Prices come from the saved settings over the configured table. */
export class UsageMeter {
  constructor(readonly limiter: UserLimiter, private readonly prices: () => PriceTable, private readonly fallback: ModelPrice, private readonly totals?: Pick<Store, "addTokenTotals">) {}

  /** Adds one model call's cost, priced with the given model id, and counts its tokens in the lifetime totals. Nothing is charged without a payer. */
  async record(who: Attribution | undefined, model: string, usage: Json): Promise<void> {
    if (!who) return;
    const costMicros = usageCostMicros(usage, model, this.prices(), this.fallback);
    await this.limiter.record(who.server, who.user, costMicros);
    // Totals are for stats only. A failed write is logged and never fails the user's request.
    try {
      await this.totals?.addTokenTotals(who.server, who.user, model, { ...usageTokens(usage), costMicros }, Date.now());
    } catch (error) {
      logError("token_totals_record_failed", error, { stage: "token totals", server: who.server });
    }
  }

  /** True when the payer is past the grace limit. Bot work has no payer, so it is never stopped here. */
  async overGrace(who: Attribution | undefined): Promise<boolean> {
    return who ? this.limiter.overGrace(who.server, who.user) : false;
  }
}

/**
 * Runs one model stream and charges it. Each usage event is charged as it arrives.
 * A provider that sends no usage is charged the estimate. A stream that fails or is abandoned is not charged.
 */
export async function* streamMetered(llm: LLM, prompt: Prompt, options: { usage?: UsageMeter | undefined; who?: Attribution | undefined; signal?: AbortSignal | undefined; estimate?: Json | undefined } = {}): AsyncIterable<ModelEvent> {
  const model = llm.model ?? UNKNOWN_MODEL;
  const estimate = options.estimate ?? promptEstimate(prompt, llm.outputTokenLimit ?? DEFAULT_OUTPUT_TOKENS);
  let reported = false;
  for await (const event of llm.stream(prompt, options.signal)) {
    if (event.kind === "usage") { reported = true; await options.usage?.record(options.who, model, event.payload); }
    yield event;
  }
  if (!reported) await options.usage?.record(options.who, model, estimate);
}

/** Every model id Slopbot can call. Admins set prices for these ids. */
export function modelsInUse(config: Pick<Config, "model" | "jevModel" | "embeddingModel" | "baseUrl">): string[] {
  return [...new Set([config.model, config.jevModel, embeddingPriceModel(config.baseUrl, config.embeddingModel)])];
}

/** Builds the one meter for the process. Limits and prices come from the config and the saved settings. */
export function createUsageMeter(config: Config, store: UsageStore): UsageMeter {
  const limiter = new UserLimiter(store, { fiveHourCostMicros: config.userLimit5hCostMicros, weekCostMicros: config.userLimitWeekCostMicros, gracePercent: config.userLimitGracePercent });
  return new UsageMeter(limiter, () => activePrices(store.setting(GLOBAL_SETTINGS_SCOPE, "model_prices"), config.modelPrices), config.fallbackPrice, store);
}
