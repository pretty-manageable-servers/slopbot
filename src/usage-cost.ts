/** Prices are micro-dollars per one million tokens, by kind of token. */
export interface ModelPrice { input: number; cached_input: number; output: number }
export type PriceTable = Readonly<Record<string, ModelPrice>>;

/** Settings that apply to every server are stored under this scope. */
export const GLOBAL_SETTINGS_SCOPE = "global";
// Used for unknown models. It is high on purpose, so an unpriced model never looks free.
export const DEFAULT_FALLBACK_PRICE: ModelPrice = { input: 10000000, cached_input: 10000000, output: 30000000 };

function validPrice(value: unknown): ModelPrice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { input, cached_input, output } = value as Record<string, unknown>;
  const whole = (number: unknown) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
  return whole(input) && whole(cached_input) && whole(output) ? { input: input as number, cached_input: cached_input as number, output: output as number } : undefined;
}

/** Parses a MODEL_PRICES style JSON object. Invalid configuration throws at startup. */
export function parseModelPrices(text: string | undefined, key: string): PriceTable {
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${key} must be a JSON object`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${key} must be a JSON object`);
  const table: Record<string, ModelPrice> = {};
  for (const [model, value] of Object.entries(parsed)) {
    const price = validPrice(value);
    if (!price) throw new Error(`${key} entry ${model} needs whole-number input, cached_input and output`);
    table[model] = price;
  }
  return table;
}

/** Parses the fallback price. It must not be zero, or unknown models would be free. */
export function parseFallbackPrice(text: string | undefined, key: string): ModelPrice {
  if (text === undefined || text.trim() === "") return DEFAULT_FALLBACK_PRICE;
  const price = validPrice(JSON.parse(text));
  if (!price || price.input + price.output === 0) throw new Error(`${key} must be JSON with whole-number input, cached_input and output, and a non-zero input or output`);
  return price;
}

/** Merges prices saved in the store over the configured defaults. Invalid saved entries are ignored. */
export function activePrices(saved: unknown, defaults: PriceTable): PriceTable {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaults;
  const valid = Object.entries(saved).flatMap(([model, value]) => { const price = validPrice(value); return price ? [[model, price] as const] : []; });
  return { ...defaults, ...Object.fromEntries(valid) };
}

/** Token counts of one model call. input is the uncached prompt; cached is the cached part of the prompt. */
export function usageTokens(usage: unknown): { input: number; output: number; cached: number } {
  const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const value = (usage && typeof usage === "object" ? usage : {}) as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  const prompt = tokens(value.prompt_tokens), completion = tokens(value.completion_tokens);
  const cached = Math.min(prompt, tokens(value.prompt_tokens_details?.cached_tokens));
  return { input: prompt - cached, output: completion, cached };
}

/** Cost in micro-dollars of one model call. Rounds up, so any real usage costs at least 1. */
export function usageCostMicros(usage: unknown, model: string, prices: PriceTable, fallback: ModelPrice): number {
  const { input, output, cached } = usageTokens(usage);
  const price = prices[model] ?? fallback;
  return Math.ceil((input * price.input + cached * price.cached_input + output * price.output) / 1000000);
}
