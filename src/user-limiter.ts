import type { Store, UserLimitState, UserLimitWindow } from "./ports.js";
import { GLOBAL_SETTINGS_SCOPE } from "./usage-cost.js";

/** Limits are shared by one user across all servers and web chats. Counters, resets and limit settings use this scope. */
export const USER_LIMIT_SCOPE = GLOBAL_SETTINGS_SCOPE;

const HOUR_MS = 3600000;
// Each window starts at the user's first spend after the previous window ended.
export const USER_LIMIT_WINDOWS = [
  { kind: "5h", durationMs: 5 * HOUR_MS, setting: "user_limit_5h_cost_micros" },
  { kind: "week", durationMs: 7 * 24 * HOUR_MS, setting: "user_limit_week_cost_micros" },
] as const;

/** Global setting: Record<userId, UserLimitOverride>. A set value replaces the global limit for that user; 0 means no limit. */
export const USER_LIMIT_OVERRIDES_SETTING = "user_limit_overrides";
/** null uses the global limit. */
export interface UserLimitOverride { five_hour_cost_micros: number | null; week_cost_micros: number | null }
const MAX_OVERRIDE_MICROS = 1000000000000;

/** One override field: a safe whole number from 0 to 1e12, else null. */
function overrideField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_OVERRIDE_MICROS ? value : null;
}

/** The valid override of one user in the saved setting, or null. Invalid values become null. */
export function limitOverride(saved: unknown, user: string): UserLimitOverride | null {
  if (!saved || typeof saved !== "object" || Array.isArray(saved) || !Object.hasOwn(saved, user)) return null;
  const entry = (saved as Record<string, unknown>)[user];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const row = entry as Record<string, unknown>;
  const five = overrideField(row.five_hour_cost_micros), week = overrideField(row.week_cost_micros);
  if (five === null && week === null) return null;
  return { five_hour_cost_micros: five, week_cost_micros: week };
}

export type UserLimit = { allowed: true } | { allowed: false; resetAt: number };
export interface UserLimitDefaults { fiveHourCostMicros: number; weekCostMicros: number; gracePercent: number }
export interface UserUsageWindow { kind: string; spent: number; limit: number; resetAt: number | null; banked: number }
export type UserLimitStore = Pick<Store, "userUsage" | "updateUserLimits" | "useReset"> & { setting(server: string, key: string): unknown };

export class UserLimitError extends Error {
  override name = "UserLimitError";
  constructor(readonly resetAt: number) { super("Usage limit reached"); }
}

export function limitReply(resetAt: number): string {
  return `Usage limit reached. Try again <t:${Math.ceil(resetAt / 1000)}:R>.`;
}

interface WindowState { kind: string; durationMs: number; limit: number; running: boolean; windowStart: number; spent: number }

/**
 * Spend limits per user in two fixed windows (5 hours and 7 days, in micro-dollars).
 * A limit of 0 means no limit. Work is refused before it starts when a window is at its limit.
 * A run that started under the limit may finish: the grace percent lets it go past the limit
 * before its later tool rounds stop.
 */
export class UserLimiter {
  constructor(private readonly store: UserLimitStore, private readonly defaults: UserLimitDefaults) {}

  /** Refuses when any window with a limit has spent at least that much. Records nothing. */
  async check(user: string, now = Date.now()): Promise<UserLimit> {
    const blocked = (await this.states(user, now)).filter(window => window.limit > 0 && window.spent >= window.limit);
    if (!blocked.length) return { allowed: true };
    return { allowed: false, resetAt: Math.max(...blocked.map(window => window.windowStart + window.durationMs)) };
  }

  /** Adds one model call's cost to both windows. */
  async record(user: string, costMicros: number, now = Date.now()): Promise<void> {
    if (!Number.isSafeInteger(costMicros) || costMicros <= 0) return;
    await this.store.updateUserLimits(USER_LIMIT_SCOPE, user, rows => ({
      windows: this.windows(user, rows, now).map(window => ({ kind: window.kind, windowStart: window.windowStart, spent: window.spent + costMicros })),
      result: undefined,
    }));
  }

  /** True when a window has spent more than its limit plus the grace percent. Used between tool rounds. */
  async overGrace(user: string, now = Date.now()): Promise<boolean> {
    const grace = this.saved("user_limit_grace_percent", this.defaults.gracePercent, 1000);
    return (await this.states(user, now)).some(window => window.limit > 0 && window.spent * 100 > window.limit * (100 + grace));
  }

  /** Spend, limit, reset time and banked resets for each window. */
  async usage(user: string, now = Date.now()): Promise<UserUsageWindow[]> {
    return this.summarize(user, await this.store.userUsage(USER_LIMIT_SCOPE, user), now);
  }

  /** The same view as usage, for a state the caller already read. */
  summarize(user: string, state: UserLimitState, now = Date.now()): UserUsageWindow[] {
    return this.windows(user, state.windows, now).map(window => ({ kind: window.kind, spent: window.spent, limit: window.limit, resetAt: window.running ? window.windowStart + window.durationMs : null, banked: state.resets[window.kind] ?? 0 }));
  }

  /** Uses one banked reset and clears that window. Returns false when none is banked. */
  useReset(user: string, kind: string): Promise<boolean> {
    return this.store.useReset(USER_LIMIT_SCOPE, user, kind);
  }

  private async states(user: string, now: number): Promise<WindowState[]> {
    const state = await this.store.userUsage(USER_LIMIT_SCOPE, user);
    return this.windows(user, state.windows, now);
  }

  /** Current state of each window. A window that has ended counts as empty until the next spend. The user's override replaces the global limit when it is set. */
  private windows(user: string, rows: readonly UserLimitWindow[], now: number): WindowState[] {
    const override = limitOverride(this.store.setting(USER_LIMIT_SCOPE, USER_LIMIT_OVERRIDES_SETTING), user);
    return USER_LIMIT_WINDOWS.map(window => {
      const stored = rows.find(row => row.kind === window.kind);
      const running = stored !== undefined && now < stored.windowStart + window.durationMs;
      const fallback = window.kind === "5h" ? this.defaults.fiveHourCostMicros : this.defaults.weekCostMicros;
      const overridden = window.kind === "5h" ? override?.five_hour_cost_micros : override?.week_cost_micros;
      const limit = overridden ?? this.saved(window.setting, fallback);
      return { kind: window.kind, durationMs: window.durationMs, limit, running, windowStart: running ? stored.windowStart : now, spent: running ? stored.spent : 0 };
    });
  }

  private saved(key: string, fallback: number, max = 1000000000000): number {
    return savedLimit(this.store.setting(USER_LIMIT_SCOPE, key), fallback, max);
  }
}

/** A saved limit setting when it is a safe whole number in range, else the fallback. */
export function savedLimit(value: unknown, fallback: number, max = 1000000000000): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
}

/** The plan every user is on for now. Change it here only. */
export const PLAN_NAME = "Seed";

/** What the console meter and the Discord /usage command show. Percents only: no costs, spend or limit amounts. percent is null when no limit is set. */
export interface UsageView { plan: string; windows: { kind: string; percent: number | null; resetAt: number | null; banked: number }[] }

/** Builds the meter view from the windows of UserLimiter.usage. Percent is rounded and capped at 100. */
export function usageView(windows: readonly UserUsageWindow[], plan = PLAN_NAME): UsageView {
  return {
    plan,
    windows: windows.map(window => ({
      kind: window.kind,
      percent: window.limit > 0 ? Math.min(100, Math.round(window.spent * 100 / window.limit)) : null,
      resetAt: window.resetAt,
      banked: window.banked,
    })),
  };
}
