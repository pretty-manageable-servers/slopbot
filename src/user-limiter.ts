import type { Store, UserLimitState, UserLimitWindow } from "./ports.js";

const HOUR_MS = 3600000;
// Each window starts at the user's first spend after the previous window ended.
export const USER_LIMIT_WINDOWS = [
  { kind: "5h", durationMs: 5 * HOUR_MS, setting: "user_limit_5h_cost_micros" },
  { kind: "week", durationMs: 7 * 24 * HOUR_MS, setting: "user_limit_week_cost_micros" },
] as const;

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
  async check(server: string, user: string, now = Date.now()): Promise<UserLimit> {
    const blocked = (await this.states(server, user, now)).filter(window => window.limit > 0 && window.spent >= window.limit);
    if (!blocked.length) return { allowed: true };
    return { allowed: false, resetAt: Math.max(...blocked.map(window => window.windowStart + window.durationMs)) };
  }

  /** Adds one model call's cost to both windows. */
  async record(server: string, user: string, costMicros: number, now = Date.now()): Promise<void> {
    if (!Number.isSafeInteger(costMicros) || costMicros <= 0) return;
    await this.store.updateUserLimits(server, user, rows => ({
      windows: this.windows(server, rows, now).map(window => ({ kind: window.kind, windowStart: window.windowStart, spent: window.spent + costMicros })),
      result: undefined,
    }));
  }

  /** True when a window has spent more than its limit plus the grace percent. Used between tool rounds. */
  async overGrace(server: string, user: string, now = Date.now()): Promise<boolean> {
    const grace = this.saved(server, "user_limit_grace_percent", this.defaults.gracePercent, 1000);
    return (await this.states(server, user, now)).some(window => window.limit > 0 && window.spent * 100 > window.limit * (100 + grace));
  }

  /** Spend, limit, reset time and banked resets for each window. */
  async usage(server: string, user: string, now = Date.now()): Promise<UserUsageWindow[]> {
    return this.summarize(server, await this.store.userUsage(server, user), now);
  }

  /** The same view as usage, for a state the caller already read. */
  summarize(server: string, state: UserLimitState, now = Date.now()): UserUsageWindow[] {
    return this.windows(server, state.windows, now).map(window => ({ kind: window.kind, spent: window.spent, limit: window.limit, resetAt: window.running ? window.windowStart + window.durationMs : null, banked: state.resets[window.kind] ?? 0 }));
  }

  /** Uses one banked reset and clears that window. Returns false when none is banked. */
  useReset(server: string, user: string, kind: string): Promise<boolean> {
    return this.store.useReset(server, user, kind);
  }

  private async states(server: string, user: string, now: number): Promise<WindowState[]> {
    const state = await this.store.userUsage(server, user);
    return this.windows(server, state.windows, now);
  }

  /** Current state of each window. A window that has ended counts as empty until the next spend. */
  private windows(server: string, rows: readonly UserLimitWindow[], now: number): WindowState[] {
    return USER_LIMIT_WINDOWS.map(window => {
      const stored = rows.find(row => row.kind === window.kind);
      const running = stored !== undefined && now < stored.windowStart + window.durationMs;
      const fallback = window.kind === "5h" ? this.defaults.fiveHourCostMicros : this.defaults.weekCostMicros;
      return { kind: window.kind, durationMs: window.durationMs, limit: this.saved(server, window.setting, fallback), running, windowStart: running ? stored.windowStart : now, spent: running ? stored.spent : 0 };
    });
  }

  private saved(server: string, key: string, fallback: number, max = 1000000000000): number {
    return savedLimit(this.store.setting(server, key), fallback, max);
  }
}

/** A saved limit setting when it is a safe whole number in range, else the fallback. */
export function savedLimit(value: unknown, fallback: number, max = 1000000000000): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
}
