import type { Config } from "./config.js";
import type { Json } from "./domain.js";
import type { Store, TokenSums } from "./ports.js";
import { savedLimit, type UserLimiter } from "./user-limiter.js";
import { activePrices, GLOBAL_SETTINGS_SCOPE, type ModelPrice } from "./usage-cost.js";
import { modelsInUse } from "./usage-meter.js";
import type { MemberDirectory, MemberProfile } from "./member-directory.js";
import { DEFAULT_INSTRUCTIONS, fullSystemText } from "./agent-runner.js";
import type { PresentationPolicy } from "./presentation/policy.js";

/** A bad value sent by a team admin. The console answers 400 with the message. */
export class AdminInputError extends Error { override name = "AdminInputError"; }

export const SNOWFLAKE = /^\d{17,20}$/;
const MAX_COST_MICROS = 1000000000000;
// Per one million tokens. $1000 per million is far above any real price.
const MAX_PRICE_MICROS = 1000000000;
const MAX_GRACE_PERCENT = 1000;
const MAX_GRANT = 100;
const USAGE_LIST_LIMIT = 200;
const MEMBER_SEARCH_LIMIT = 10;
const MAX_SEARCH_CHARS = 100;
const LIMIT_KEYS = { five: "user_limit_5h_cost_micros", week: "user_limit_week_cost_micros", grace: "user_limit_grace_percent" } as const;
const MAX_SYSTEM_PROMPT_CHARS = 8000;
const SYSTEM_PROMPT_KEY = "system_prompt";
const SERVER_PAGE_DEFAULT = 20;
const SERVER_PAGE_MAX = 50;
const TOTAL_TOP = 10;

export type AdminConfig = Pick<Config, "model" | "jevModel" | "embeddingModel" | "baseUrl" | "modelPrices" | "fallbackPrice" | "userLimit5hCostMicros" | "userLimitWeekCostMicros" | "userLimitGracePercent">;
export type AdminStore = Pick<Store, "listUserUsage" | "resetUserUsage" | "grantResets" | "tokenTotalsSummary"> & { setting(server: string, key: string): unknown; setSetting(server: string, key: string, value: Json): void | Promise<void> };
export type WindowKind = "5h" | "week";
export interface LimitValues { five_hour_cost_micros: number; week_cost_micros: number; grace_percent: number }
export interface LimitsView extends LimitValues { server: string; defaults: LimitValues }
/** configured is the price from the config table; fallback is used when the config has no price for the model. */
export type PriceSource = "config" | "fallback";
/** One model. default is the price with no override; override is the saved team price, or null. The price in use is override ?? default. */
export interface PriceRow { model: string; default: ModelPrice & { source: PriceSource }; override: ModelPrice | null }
export interface PricesView { models: PriceRow[]; fallback: ModelPrice }
export interface SystemPromptView { text: string | null; default: string; max: number }
/** One row of the usage totals. total_tokens is input_tokens (not cached) + cached_tokens + output_tokens. */
export interface UsageRow { requests: number; cost_micros: number; total_tokens: number; input_tokens: number; cached_tokens: number; output_tokens: number }
/** Display name and icon URL of a server. The icon is null when Discord has none. */
export interface ServerInfo { name: string; icon: string | null }
export interface TotalUsageView {
  total: UsageRow;
  servers: (UsageRow & ServerInfo & { server: string })[];
  models: (UsageRow & { model: string })[];
}
export interface ServerPage { q: string; offset: number; limit: number }
/** One row of the server list. transcriptsOn counts the channels with web transcripts on. */
export interface ServerListRow { id: string; name: string; icon?: string | null; channelCount: number; transcriptsOn: number }

export function snowflake(value: unknown, what: string): string {
  if (typeof value !== "string" || !SNOWFLAKE.test(value)) throw new AdminInputError(`Invalid ${what}.`);
  return value;
}

/** The server list query: q (name contains, any case), offset and limit (1 to 50, default 20). Bad values throw AdminInputError. */
export function serverPage(query: URLSearchParams): ServerPage {
  const q = (query.get("q") ?? "").trim();
  if (q.length > MAX_SEARCH_CHARS) throw new AdminInputError("Search for 100 characters or fewer.");
  const offset = query.get("offset") ?? "0", limit = query.get("limit") ?? String(SERVER_PAGE_DEFAULT);
  if (!/^\d{1,9}$/.test(offset)) throw new AdminInputError("Offset must be a whole number.");
  if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > SERVER_PAGE_MAX) throw new AdminInputError(`Limit must be from 1 to ${SERVER_PAGE_MAX}.`);
  return { q, offset: Number(offset), limit: Number(limit) };
}

/** Keeps the rows whose name contains the query (any case), sorts them by name, and returns one page with the match count. */
export function pageItems<T extends { name: string }>(items: readonly T[], page: ServerPage): { servers: T[]; total: number } {
  const needle = page.q.toLowerCase();
  const matches = items.filter(item => item.name.toLowerCase().includes(needle)).sort((a, b) => a.name.localeCompare(b.name));
  return { servers: matches.slice(page.offset, page.offset + page.limit), total: matches.length };
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminInputError(message);
  return value as Record<string, unknown>;
}

function wholeNumber(value: unknown, max: number, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new AdminInputError(message);
  return value;
}

function windowKind(value: unknown): WindowKind {
  if (value !== "5h" && value !== "week") throw new AdminInputError("Choose window 5h or week.");
  return value;
}

function modelName(value: unknown): string {
  // __proto__ would change the saved table's prototype, so it is refused.
  if (typeof value !== "string" || !/^[^\s\u0000-\u001f]{1,200}$/.test(value) || value === "__proto__") throw new AdminInputError("Model ID must be 1 to 200 characters with no spaces.");
  return value;
}

/** The usage columns of one group of token totals. */
function usageRow(sums: TokenSums): UsageRow {
  return { requests: sums.requests, cost_micros: sums.costMicros, total_tokens: sums.input + sums.cached + sums.output, input_tokens: sums.input, cached_tokens: sums.cached, output_tokens: sums.output };
}

/** Limits, model prices and user usage for the team admin panel. Every change is validated before it is saved. */
export class AdminPanel {
  /** presentation is the same rule set the runs use, so the full prompt view matches a real run. */
  constructor(private readonly config: AdminConfig, private readonly store: AdminStore, private readonly limiter: UserLimiter, private readonly directory: Pick<MemberDirectory, "profiles" | "search">, private readonly presentation?: PresentationPolicy) {}

  /** Lifetime token totals over all servers, with the top servers and models by cost. Server name and icon come from info. */
  async totalUsage(info: (server: string) => ServerInfo): Promise<TotalUsageView> {
    const summary = await this.store.tokenTotalsSummary(TOTAL_TOP);
    return {
      total: usageRow(summary.total),
      servers: summary.servers.map(row => ({ server: row.server, ...info(row.server), ...usageRow(row) })),
      models: summary.models.map(row => ({ model: row.model, ...usageRow(row) })),
    };
  }

  /** The whole system text a run sends for the saved or default prompt. The tool schemas are not included. */
  fullSystemPrompt(): { text: string } {
    const saved = this.store.setting(GLOBAL_SETTINGS_SCOPE, SYSTEM_PROMPT_KEY);
    const base = typeof saved === "string" && saved.trim() !== "" ? saved.trim() : DEFAULT_INSTRUCTIONS;
    return { text: fullSystemText(base, this.presentation) };
  }

  limits(server: unknown): LimitsView {
    return this.limitsView(snowflake(server, "server"));
  }

  async saveLimits(body: unknown): Promise<LimitsView> {
    const input = object(body, "Send limits as an object.");
    const server = snowflake(input.server, "server");
    const values = {
      five_hour_cost_micros: wholeNumber(input.five_hour_cost_micros, MAX_COST_MICROS, "The 5-hour limit must be a whole number of micro-dollars from 0 to 1000000000000."),
      week_cost_micros: wholeNumber(input.week_cost_micros, MAX_COST_MICROS, "The weekly limit must be a whole number of micro-dollars from 0 to 1000000000000."),
      grace_percent: wholeNumber(input.grace_percent, MAX_GRACE_PERCENT, "The grace percent must be a whole number from 0 to 1000."),
    };
    await this.store.setSetting(server, LIMIT_KEYS.five, values.five_hour_cost_micros);
    await this.store.setSetting(server, LIMIT_KEYS.week, values.week_cost_micros);
    await this.store.setSetting(server, LIMIT_KEYS.grace, values.grace_percent);
    return this.limitsView(server);
  }

  private limitsView(server: string): LimitsView {
    const defaults = { five_hour_cost_micros: this.config.userLimit5hCostMicros, week_cost_micros: this.config.userLimitWeekCostMicros, grace_percent: this.config.userLimitGracePercent };
    return {
      server,
      five_hour_cost_micros: savedLimit(this.store.setting(server, LIMIT_KEYS.five), defaults.five_hour_cost_micros),
      week_cost_micros: savedLimit(this.store.setting(server, LIMIT_KEYS.week), defaults.week_cost_micros),
      grace_percent: savedLimit(this.store.setting(server, LIMIT_KEYS.grace), defaults.grace_percent, MAX_GRACE_PERCENT),
      defaults,
    };
  }

  /**
   * One row per model. The default is the configured price, or the fallback when the config has none.
   * The override is the saved price. Billing uses activePrices(saved, config)[model] ?? fallback, so the price in use is override ?? default.
   */
  prices(): PricesView {
    const configured = activePrices({}, this.config.modelPrices);
    const overrides = activePrices(this.savedPrices(), {});
    const fallback = this.config.fallbackPrice;
    const names = [...new Set([...modelsInUse(this.config), ...Object.keys(configured), ...Object.keys(overrides)])].sort();
    return {
      models: names.map((model): PriceRow => {
        const price = configured[model];
        const source: PriceSource = price ? "config" : "fallback";
        return { model, default: { ...(price ?? fallback), source }, override: overrides[model] ?? null };
      }),
      fallback,
    };
  }

  /** Adds or replaces one saved price (the override). With remove: true, drops the saved price, so the default applies again. This is the reset path. */
  async savePrice(body: unknown): Promise<PricesView> {
    const input = object(body, "Send a price as an object.");
    const model = modelName(input.model);
    const table = this.savedPrices();
    if (input.remove === true) delete table[model];
    else table[model] = {
      input: wholeNumber(input.input, MAX_PRICE_MICROS, "Input price must be a whole number of micro-dollars per million tokens, from 0 to 1000000000."),
      cached_input: wholeNumber(input.cached_input, MAX_PRICE_MICROS, "Cached input price must be a whole number of micro-dollars per million tokens, from 0 to 1000000000."),
      output: wholeNumber(input.output, MAX_PRICE_MICROS, "Output price must be a whole number of micro-dollars per million tokens, from 0 to 1000000000."),
    };
    await this.store.setSetting(GLOBAL_SETTINGS_SCOPE, "model_prices", table as Json);
    return this.prices();
  }

  /** The saved system prompt for all servers, or null when the default is used. */
  systemPrompt(): SystemPromptView {
    const saved = this.store.setting(GLOBAL_SETTINGS_SCOPE, SYSTEM_PROMPT_KEY);
    return { text: typeof saved === "string" && saved.trim() !== "" ? saved : null, default: DEFAULT_INSTRUCTIONS, max: MAX_SYSTEM_PROMPT_CHARS };
  }

  /** Saves the system prompt for all servers. Empty text saves null, which means the default is used. */
  async saveSystemPrompt(body: unknown): Promise<SystemPromptView> {
    const input = object(body, "Send the prompt as an object.");
    if (typeof input.text !== "string") throw new AdminInputError("The prompt must be text.");
    const text = input.text.trim();
    if (text.length > MAX_SYSTEM_PROMPT_CHARS) throw new AdminInputError(`The prompt must be ${MAX_SYSTEM_PROMPT_CHARS} characters or fewer.`);
    await this.store.setSetting(GLOBAL_SETTINGS_SCOPE, SYSTEM_PROMPT_KEY, text === "" ? null : text);
    return this.systemPrompt();
  }

  private savedPrices(): Record<string, Json> {
    const saved = this.store.setting(GLOBAL_SETTINGS_SCOPE, "model_prices");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } as Record<string, Json> : {};
  }

  /** Every user with counters in the server, or one user when user is given. Each user has an id and a profile. */
  async usage(server: unknown, user?: unknown): Promise<unknown> {
    const id = snowflake(server, "server");
    if (user === undefined) {
      const rows = await this.store.listUserUsage(id, USAGE_LIST_LIMIT);
      const profiles = await this.directory.profiles(id, rows.map(row => row.user));
      return { server: id, users: rows.map(row => ({ user: profiles.get(row.user)!, windows: this.limiter.summarize(id, row) })) };
    }
    const member = snowflake(user, "user");
    const profile = (await this.directory.profiles(id, [member])).get(member)!;
    return { server: id, user: profile, windows: await this.limiter.usage(id, member) };
  }

  /** Server members whose name starts with the query, for the user picker. An empty query finds nobody. */
  async members(server: unknown, query: unknown): Promise<{ server: string; members: MemberProfile[] }> {
    const id = snowflake(server, "server");
    if (typeof query !== "string") throw new AdminInputError("Search needs text.");
    const text = query.trim();
    if (text.length > MAX_SEARCH_CHARS) throw new AdminInputError("Search for 100 characters or fewer.");
    return { server: id, members: await this.directory.search(id, text, MEMBER_SEARCH_LIMIT) };
  }

  /** Clears one window, or both when kind is not given. Banked resets are not used. */
  async resetUsage(body: unknown): Promise<unknown> {
    const input = object(body, "Send a reset as an object.");
    const server = snowflake(input.server, "server"), user = snowflake(input.user, "user");
    const kind = input.kind === undefined ? undefined : windowKind(input.kind);
    await this.store.resetUserUsage(server, user, kind);
    return { server, user, kind: kind ?? "all", windows: await this.limiter.usage(server, user) };
  }

  /** Adds banked resets for one window. */
  async grantResets(body: unknown): Promise<unknown> {
    const input = object(body, "Send a grant as an object.");
    const server = snowflake(input.server, "server"), user = snowflake(input.user, "user"), kind = windowKind(input.kind);
    const count = wholeNumber(input.count, MAX_GRANT, "Grant between 1 and 100 resets.");
    if (count < 1) throw new AdminInputError("Grant between 1 and 100 resets.");
    await this.store.grantResets(server, user, kind, count);
    return { server, user, kind, granted: count, windows: await this.limiter.usage(server, user) };
  }
}
