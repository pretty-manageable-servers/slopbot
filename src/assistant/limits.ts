import type { Json } from "../domain.js";
import { GLOBAL_SETTINGS_SCOPE } from "../usage-cost.js";
import { ASSISTANT_LIMITS_KEY, DEFAULT_ASSISTANT_LIMITS, type AssistantLimits } from "./types.js";

/** Inclusive whole-number range of each limit. */
export const ASSISTANT_LIMIT_RANGES: Record<keyof AssistantLimits, { min: number; max: number }> = {
  maxActiveTasks: { min: 0, max: 100 },
  minWakeMinutes: { min: 15, max: 10080 },
  maxPendingApprovals: { min: 1, max: 200 },
  approvalTtlHours: { min: 1, max: 720 },
  mentionDebounceMinutes: { min: 0, max: 1440 },
};

/** Clamps each limit into its range. A value that is not a whole number takes its default. Missing fields take their defaults. */
export function clampAssistantLimits(value: unknown): AssistantLimits {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const limits = { ...DEFAULT_ASSISTANT_LIMITS };
  for (const key of Object.keys(ASSISTANT_LIMIT_RANGES) as (keyof AssistantLimits)[]) {
    const input = raw[key];
    if (typeof input !== "number" || !Number.isInteger(input)) continue;
    const { min, max } = ASSISTANT_LIMIT_RANGES[key];
    limits[key] = Math.min(max, Math.max(min, input));
  }
  return limits;
}

/** The assistant limits from the global settings, clamped and merged with the defaults. */
export function readAssistantLimits(store: { setting(server: string, key: string): unknown }): AssistantLimits {
  return clampAssistantLimits(store.setting(GLOBAL_SETTINGS_SCOPE, ASSISTANT_LIMITS_KEY) as Json | undefined);
}
