import type { Config } from "./config.js";
import type { Json } from "./domain.js";
import type { KnownUserRow, Store, TokenSums, UserTokenTotalRow } from "./ports.js";
import { limitOverride, savedLimit, USER_LIMIT_OVERRIDES_SETTING, USER_LIMIT_SCOPE, type UserLimiter, type UserLimitOverride, type UserUsageWindow } from "./user-limiter.js";
import { activePrices, GLOBAL_SETTINGS_SCOPE, type ModelPrice } from "./usage-cost.js";
import { modelsInUse } from "./usage-meter.js";
import type { MemberDirectory, MemberProfile } from "./member-directory.js";
import { DEFAULT_INSTRUCTIONS, fullSystemText } from "./agent-runner.js";
import type { PresentationPolicy } from "./presentation/policy.js";
import { newProviderKeyRow, WebKeySecrets } from "./web-keys.js";
import { DEFAULT_KEY_CAPS, KEY_CAPS_SETTING, KEY_ERRORS_SETTING, KEYED_PROVIDERS, usageMonth, type KeyedProvider, type KeyError } from "./web-providers.js";

/** A bad value sent by a team admin. The console answers 400 with the message. */
export class AdminInputError extends Error { override name = "AdminInputError"; }

export const SNOWFLAKE = /^\d{17,20}$/;
const MAX_COST_MICROS = 1000000000000;
// Per one million tokens. $1000 per million is far above any real price.
const MAX_PRICE_MICROS = 1000000000;
const MAX_GRACE_PERCENT = 1000;
const MAX_GRANT = 100;
const MAX_SEARCH_CHARS = 100;
/** Page sizes of the users list. */
const USER_PAGE_SIZES = [5, 10, 25, 50] as const;
/** A lookup of one user by exact ID. */
const USER_LOOKUP_LIMIT = 10;
const LIMIT_KEYS = { five: "user_limit_5h_cost_micros", week: "user_limit_week_cost_micros", grace: "user_limit_grace_percent" } as const;
const MAX_SYSTEM_PROMPT_CHARS = 8000;
const SYSTEM_PROMPT_KEY = "system_prompt";
const SERVER_PAGE_DEFAULT = 20;
const SERVER_PAGE_MAX = 50;
const TOTAL_TOP = 10;
const MAX_KEYS_PER_OWNER = 10;
const MAX_KEY_CAP = 100000;

export type AdminConfig = Pick<Config, "model" | "jevModel" | "embeddingModel" | "baseUrl" | "modelPrices" | "fallbackPrice" | "userLimit5hCostMicros" | "userLimitWeekCostMicros" | "userLimitGracePercent">;
/** resetProviderKey is optional: a store without it keeps the exhausted flag of a key until it has it. */
export type AdminStore = Pick<Store, "listKnownUsers" | "userTokenTotalsByServer" | "resetUserUsage" | "grantResets" | "tokenTotalsSummary" | "listProviderKeys" | "addProviderKey" | "deleteProviderKey" | "providerKeyUsage"> & { setting(server: string, key: string): unknown; setSetting(server: string, key: string, value: Json): void | Promise<void>; resetProviderKey?(id: string, month: string): void | Promise<void> };
export type WindowKind = "5h" | "week";
export interface LimitValues { five_hour_cost_micros: number; week_cost_micros: number; grace_percent: number }
export interface UserServer { id: string; name: string }
export interface UserRowView { user: MemberProfile; servers: UserServer[]; windows: UserUsageWindow[]; override: UserLimitOverride | null }
export interface UsersPageView { total: number; limit: 5 | 10 | 25 | 50; offset: number; users: UserRowView[] }
export type UserPageSize = typeof USER_PAGE_SIZES[number];
export interface UserDetailView extends UserRowView { totals: (UserTokenTotalRow & { server: string; serverName: string })[] }
export interface LimitsView extends LimitValues { defaults: LimitValues }
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
/** One team key. Never holds the secret. owner is the Discord user ID of the member who added it; mine is true for the signed-in member. */
export interface WebKeyView { id: string; provider: KeyedProvider; label: string; last4: string; owner: string; createdAt: number; used: number; exhausted: boolean; lastError: KeyError | null; mine: boolean }
/** The team web search keys. enabled is false when WEB_KEYS_SECRET is not set. caps is the monthly credit cap of each key. */
export interface WebKeysView { enabled: boolean; month: string; caps: Record<KeyedProvider, number>; keys: WebKeyView[] }

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

/** One saved key error, or null when the value does not have the KeyError shape. */
function keyError(value: unknown): KeyError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.at) || (row.at as number) < 0) return null;
  if (typeof row.status !== "string" || typeof row.message !== "string" || typeof row.exhausted !== "boolean") return null;
  return { at: row.at as number, status: row.status, message: row.message, exhausted: row.exhausted };
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
  /** secrets seals the team keys. It reads WEB_KEYS_SECRET unless a value is given. */
  constructor(private readonly config: AdminConfig, private readonly store: AdminStore, private readonly limiter: UserLimiter, private readonly directory: Pick<MemberDirectory, "profiles">, private readonly presentation?: PresentationPolicy, private readonly secrets: WebKeySecrets = new WebKeySecrets()) {}

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

  /** The global limits for every user, with the defaults from the config. */
  limits(): LimitsView {
    return this.limitsView();
  }

  async saveLimits(body: unknown): Promise<LimitsView> {
    const input = object(body, "Send limits as an object.");
    const values = {
      five_hour_cost_micros: wholeNumber(input.five_hour_cost_micros, MAX_COST_MICROS, "The 5-hour limit must be a whole number of micro-dollars from 0 to 1000000000000."),
      week_cost_micros: wholeNumber(input.week_cost_micros, MAX_COST_MICROS, "The weekly limit must be a whole number of micro-dollars from 0 to 1000000000000."),
      grace_percent: wholeNumber(input.grace_percent, MAX_GRACE_PERCENT, "The grace percent must be a whole number from 0 to 1000."),
    };
    await this.store.setSetting(USER_LIMIT_SCOPE, LIMIT_KEYS.five, values.five_hour_cost_micros);
    await this.store.setSetting(USER_LIMIT_SCOPE, LIMIT_KEYS.week, values.week_cost_micros);
    await this.store.setSetting(USER_LIMIT_SCOPE, LIMIT_KEYS.grace, values.grace_percent);
    return this.limitsView();
  }

  private limitsView(): LimitsView {
    const defaults = { five_hour_cost_micros: this.config.userLimit5hCostMicros, week_cost_micros: this.config.userLimitWeekCostMicros, grace_percent: this.config.userLimitGracePercent };
    return {
      five_hour_cost_micros: savedLimit(this.store.setting(USER_LIMIT_SCOPE, LIMIT_KEYS.five), defaults.five_hour_cost_micros),
      week_cost_micros: savedLimit(this.store.setting(USER_LIMIT_SCOPE, LIMIT_KEYS.week), defaults.week_cost_micros),
      grace_percent: savedLimit(this.store.setting(USER_LIMIT_SCOPE, LIMIT_KEYS.grace), defaults.grace_percent, MAX_GRACE_PERCENT),
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

  /**
   * One page of the known users, sorted by the store. q is a name substring or an exact ID (empty finds all).
   * limit must be 5, 10, 25 or 50. Server names come from info. Profiles come from each user's first server.
   */
  async users(q: unknown, limit: unknown, offset: unknown, info: (server: string) => ServerInfo): Promise<UsersPageView> {
    if (typeof q !== "string") throw new AdminInputError("Search needs text.");
    const search = q.trim();
    if (search.length > MAX_SEARCH_CHARS) throw new AdminInputError("Search for 100 characters or fewer.");
    if (typeof limit !== "number" || !(USER_PAGE_SIZES as readonly number[]).includes(limit)) throw new AdminInputError(`Page size must be ${USER_PAGE_SIZES.join(", ")}.`);
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new AdminInputError("Offset must be a whole number.");
    const page = await this.store.listKnownUsers(search, limit, offset);
    return { total: page.total, limit: limit as UserPageSize, offset, users: await this.rowViews(page.users, info) };
  }

  /** One user: windows, override, servers and lifetime token totals by server and model. */
  async user(id: unknown, info: (server: string) => ServerInfo): Promise<UserDetailView> {
    return this.detail(snowflake(id, "user"), info);
  }

  /** Clears one window, or both when kind is not given. Banked resets are not used. */
  async resetUser(body: unknown, info: (server: string) => ServerInfo): Promise<UserDetailView> {
    const input = object(body, "Send a reset as an object.");
    const user = snowflake(input.user, "user");
    const kind = input.kind === undefined ? undefined : windowKind(input.kind);
    await this.store.resetUserUsage(USER_LIMIT_SCOPE, user, kind);
    return this.detail(user, info);
  }

  /** Adds banked resets for one window. */
  async grantUser(body: unknown, info: (server: string) => ServerInfo): Promise<UserDetailView> {
    const input = object(body, "Send a grant as an object.");
    const user = snowflake(input.user, "user"), kind = windowKind(input.kind);
    const count = wholeNumber(input.count, MAX_GRANT, "Grant between 1 and 100 resets.");
    if (count < 1) throw new AdminInputError("Grant between 1 and 100 resets.");
    await this.store.grantResets(USER_LIMIT_SCOPE, user, kind, count);
    return this.detail(user, info);
  }

  /**
   * Saves one user's override: a window value replaces the global limit for that user, and 0 means no limit.
   * null on a window uses the global limit. Both null removes the user's override.
   */
  async saveOverride(body: unknown, info: (server: string) => ServerInfo): Promise<UserDetailView> {
    const input = object(body, "Send an override as an object.");
    const user = snowflake(input.user, "user");
    const field = (value: unknown, name: string): number | null => value === null ? null : wholeNumber(value, MAX_COST_MICROS, `The ${name} override must be a whole number of micro-dollars from 0 to 1000000000000, or empty for the global limit.`);
    const five = field(input.five_hour_cost_micros, "5-hour"), week = field(input.week_cost_micros, "weekly");
    const table = this.savedOverrides();
    if (five === null && week === null) delete table[user];
    else table[user] = { five_hour_cost_micros: five, week_cost_micros: week };
    await this.store.setSetting(USER_LIMIT_SCOPE, USER_LIMIT_OVERRIDES_SETTING, table as Json);
    return this.detail(user, info);
  }

  /** The view of one user, with the lifetime totals of each server and model. */
  private async detail(user: string, info: (server: string) => ServerInfo): Promise<UserDetailView> {
    const known = (await this.store.listKnownUsers(user, USER_LOOKUP_LIMIT, 0)).users.find(row => row.user === user);
    const [view] = await this.rowViews([{ user, names: known?.names ?? [], servers: known?.servers ?? [] }], info);
    const totals = await this.store.userTokenTotalsByServer(user);
    return { ...view!, totals: totals.map(total => ({ ...total, serverName: info(total.server).name })) };
  }

  /** Views of known users. Each profile comes from the user's first server; a user with no server gets the ID as the name. */
  private async rowViews(rows: readonly KnownUserRow[], info: (server: string) => ServerInfo): Promise<UserRowView[]> {
    const idsByServer = new Map<string, string[]>();
    for (const row of rows) {
      const first = row.servers[0];
      if (first !== undefined) idsByServer.set(first, [...idsByServer.get(first) ?? [], row.user]);
    }
    const profiles = new Map<string, MemberProfile>();
    await Promise.all([...idsByServer].map(async ([server, ids]) => {
      for (const [id, profile] of await this.directory.profiles(server, ids)) profiles.set(id, profile);
    }));
    const saved = this.store.setting(USER_LIMIT_SCOPE, USER_LIMIT_OVERRIDES_SETTING);
    return Promise.all(rows.map(async (row): Promise<UserRowView> => ({
      user: profiles.get(row.user) ?? { id: row.user, displayName: row.user, username: null, avatarUrl: null },
      servers: row.servers.map(id => ({ id, name: info(id).name })),
      windows: await this.limiter.usage(row.user),
      override: limitOverride(saved, row.user),
    })));
  }

  private savedOverrides(): Record<string, Json> {
    const saved = this.store.setting(USER_LIMIT_SCOPE, USER_LIMIT_OVERRIDES_SETTING);
    return saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } as Record<string, Json> : {};
  }

  /** The team web search keys with this month's use and last error. Any team member may read them. Never includes a secret. */
  async webKeys(user: string): Promise<WebKeysView> {
    const month = usageMonth();
    const [rows, usage] = await Promise.all([this.store.listProviderKeys(), this.store.providerKeyUsage(month)]);
    const useOf = new Map(usage.map(row => [row.keyId, row]));
    const errors = this.keyErrors();
    return {
      enabled: this.secrets.enabled,
      month,
      caps: this.keyCaps(),
      keys: rows.map((row): WebKeyView => {
        const use = useOf.get(row.id);
        return { id: row.id, provider: row.provider, label: row.label, last4: row.last4, owner: row.owner, createdAt: row.createdAt, used: use?.used ?? 0, exhausted: use?.exhausted ?? false, lastError: Object.hasOwn(errors, row.id) ? keyError(errors[row.id]) : null, mine: row.owner === user };
      }),
    };
  }

  /** Saves one key for the signed-in member. The secret is sealed before it is stored. Each member keeps at most 10 keys per provider. */
  async addWebKey(user: string, body: unknown): Promise<WebKeysView> {
    const input = object(body, "Send a key as an object.");
    if (!this.secrets.enabled) throw new AdminInputError("Web search keys are off. The operator must set WEB_KEYS_SECRET to a base64 32-byte key, then restart Slopbot.");
    if (typeof input.provider !== "string" || !(KEYED_PROVIDERS as readonly string[]).includes(input.provider)) throw new AdminInputError(`Provider must be one of: ${KEYED_PROVIDERS.join(", ")}.`);
    const label = input.label === undefined ? "" : input.label;
    if (typeof label !== "string") throw new AdminInputError("The label must be text.");
    if (typeof input.secret !== "string") throw new AdminInputError("The key must be text.");
    const provider = input.provider as KeyedProvider;
    const owned = (await this.store.listProviderKeys()).filter(row => row.owner === user && row.provider === provider).length;
    if (owned >= MAX_KEYS_PER_OWNER) throw new AdminInputError(`You can save up to ${MAX_KEYS_PER_OWNER} ${provider} keys. Remove one first.`);
    let row;
    try { row = newProviderKeyRow(this.secrets, provider, user, label.trim(), input.secret.trim(), Date.now()); }
    catch (error) { throw new AdminInputError(error instanceof Error ? error.message : "The key is not valid."); }
    await this.store.addProviderKey(row);
    return this.webKeys(user);
  }

  /** Removes one key. The owner may remove it; a team editor may remove any key. */
  async deleteWebKey(user: string, canEdit: boolean, body: unknown): Promise<WebKeysView> {
    const input = object(body, "Send a key as an object.");
    const row = typeof input.id === "string" ? (await this.store.listProviderKeys()).find(item => item.id === input.id) : undefined;
    if (!row) throw new AdminInputError("That key does not exist. It may already be removed.");
    if (row.owner !== user && !canEdit) throw new AdminInputError("Only the key owner or a team editor can remove this key.");
    if (!await this.store.deleteProviderKey(row.id)) throw new AdminInputError("That key does not exist. It may already be removed.");
    return this.webKeys(user);
  }

  /** Clears this month's exhausted flag and the last error of one key. Only a team editor may reset a key. */
  async resetWebKey(user: string, canEdit: boolean, body: unknown): Promise<WebKeysView> {
    const input = object(body, "Send a key as an object.");
    if (!canEdit) throw new AdminInputError("Only a team editor can reset a key.");
    const row = typeof input.id === "string" ? (await this.store.listProviderKeys()).find(item => item.id === input.id) : undefined;
    if (!row) throw new AdminInputError("That key does not exist. It may already be removed.");
    await this.store.resetProviderKey?.(row.id, usageMonth());
    const errors = this.keyErrors();
    delete errors[row.id];
    await this.store.setSetting(GLOBAL_SETTINGS_SCOPE, KEY_ERRORS_SETTING, errors as Json);
    return this.webKeys(user);
  }

  /** Saves the monthly credit cap of one or both providers. Each cap is a whole number from 1 to 100000. Caps not sent keep their value. */
  async saveKeyCaps(body: unknown): Promise<Record<KeyedProvider, number>> {
    const input = object(body, "Send the caps as an object.");
    const table = this.savedCaps();
    for (const provider of KEYED_PROVIDERS) {
      const value = input[provider];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_KEY_CAP) throw new AdminInputError(`Each key cap must be a whole number from 1 to ${MAX_KEY_CAP}.`);
      table[provider] = value;
    }
    await this.store.setSetting(GLOBAL_SETTINGS_SCOPE, KEY_CAPS_SETTING, table as Json);
    return this.keyCaps();
  }

  /** The cap in use for each provider: the saved value, or the default when none is saved or it is not a positive whole number. */
  private keyCaps(): Record<KeyedProvider, number> {
    const saved = this.savedCaps();
    const caps = {} as Record<KeyedProvider, number>;
    for (const provider of KEYED_PROVIDERS) {
      const value = saved[provider];
      caps[provider] = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_KEY_CAPS[provider];
    }
    return caps;
  }

  /** The saved last error of each key, as stored. Entries are checked by keyError when they are read. */
  private keyErrors(): Record<string, unknown> {
    const saved = this.store.setting(GLOBAL_SETTINGS_SCOPE, KEY_ERRORS_SETTING);
    return saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } as Record<string, unknown> : {};
  }

  private savedCaps(): Record<string, Json> {
    const saved = this.store.setting(GLOBAL_SETTINGS_SCOPE, KEY_CAPS_SETTING);
    return saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } as Record<string, Json> : {};
  }
}
