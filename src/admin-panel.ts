import type { Config } from "./config.js";
import type { Json } from "./domain.js";
import type { Store } from "./ports.js";
import { savedLimit, type UserLimiter } from "./user-limiter.js";
import { activePrices, GLOBAL_SETTINGS_SCOPE, type ModelPrice } from "./usage-cost.js";
import { modelsInUse } from "./usage-meter.js";
import type { MemberDirectory, MemberProfile } from "./member-directory.js";

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

export type AdminConfig = Pick<Config, "model" | "jevModel" | "embeddingModel" | "baseUrl" | "modelPrices" | "fallbackPrice" | "userLimit5hCostMicros" | "userLimitWeekCostMicros" | "userLimitGracePercent">;
export type AdminStore = Pick<Store, "listUserUsage" | "resetUserUsage" | "grantResets"> & { setting(server: string, key: string): unknown; setSetting(server: string, key: string, value: Json): void | Promise<void> };
export type WindowKind = "5h" | "week";
export interface LimitValues { five_hour_cost_micros: number; week_cost_micros: number; grace_percent: number }
export interface LimitsView extends LimitValues { server: string; defaults: LimitValues }
export interface PricesView { models: string[]; saved_models: string[]; prices: Record<string, ModelPrice>; fallback: ModelPrice }

export function snowflake(value: unknown, what: string): string {
  if (typeof value !== "string" || !SNOWFLAKE.test(value)) throw new AdminInputError(`Invalid ${what}.`);
  return value;
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

/** Limits, model prices and user usage for the team admin panel. Every change is validated before it is saved. */
export class AdminPanel {
  constructor(private readonly config: AdminConfig, private readonly store: AdminStore, private readonly limiter: UserLimiter, private readonly directory: Pick<MemberDirectory, "profiles" | "search">) {}

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

  /** Active prices: the saved table merged over the configured one. */
  prices(): PricesView {
    const saved = this.savedPrices();
    const savedModels = Object.keys(saved);
    return { models: [...new Set([...modelsInUse(this.config), ...savedModels])], saved_models: savedModels, prices: activePrices(saved, this.config.modelPrices), fallback: this.config.fallbackPrice };
  }

  /** Adds or replaces one saved price. With remove, drops the saved price so the configured one applies again. */
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
