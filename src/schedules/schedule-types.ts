import type { Json } from "../domain.js";

/** app_records kind for scheduled tasks. */
export const SCHEDULE_KIND = "schedule";
/** settings key in GLOBAL_SETTINGS_SCOPE for caps and minimum intervals. */
export const SCHEDULE_LIMITS_KEY = "schedule_limits";
export const MAX_SCHEDULE_LIMIT = 1000;
/** Largest minimum interval an admin can set: one week. */
export const MAX_MIN_MINUTES = 10080;
/** Recurring schedules on the free plan expire this many days after create or renew. One-shots are at most this far ahead. */
export const FREE_PLAN_SCHEDULE_DAYS = 30;
/** Failed runs in a row before a schedule pauses. */
export const MAX_FAILURES = 3;
export const SCHEDULE_TICK_MS = 15_000;
export const SCHEDULE_RETRY_MS = 60_000;
export const MAX_SCHEDULE_TEXT = 1500;
export const MAX_SCHEDULE_NAME = 80;

export type ScheduleActionKind = "message" | "prompt" | "tool";

export interface ScheduleLimits { perServer: number; perUser: number; minMinutes: Record<ScheduleActionKind, number> }

export const DEFAULT_SCHEDULE_LIMITS: ScheduleLimits = { perServer: 50, perUser: 10, minMinutes: { message: 15, prompt: 60, tool: 60 } };

export type ScheduleWhen =
  | { kind: "once"; at: string }
  | { kind: "cron"; cron: string; timezone: string };

export type ScheduleAction =
  | { kind: "message"; text: string }
  | { kind: "prompt"; text: string }
  | { kind: "tool"; tool: string; input: Record<string, Json> };

export type ScheduleStatus = "active" | "running" | "paused" | "expired" | "cancelled" | "done";
export type PauseReason = "owner" | "failures" | "usage" | "permission";

export interface Schedule {
  id: string;
  server: string;
  channel: string;
  owner: string;
  name: string;
  when: ScheduleWhen;
  action: ScheduleAction;
  status: ScheduleStatus;
  pauseReason?: PauseReason;
  /** ISO time of the next run; null when the schedule is not active. */
  nextAt: string | null;
  /** Cron: create or renew time + FREE_PLAN_SCHEDULE_DAYS. Once: null. */
  expiresAt: string | null;
  failures: number;
  lastRunAt?: string;
  lastError?: string;
  retryAt?: string;
  createdAt: string;
  /** Original request that created the schedule. Absent on older records. */
  requestId?: string;
  renewedAt?: string;
}

/** Message id of one run: dedupe key and owner-mention allowlist prefix `command:schedule:`. */
export function scheduleMessageId(id: string, slot: string): string { return `command:schedule:${id}:${slot}`; }
/** Delivery id of one posted run. */
export function scheduleDeliveryId(id: string, slot: string): string { return `schedule:${id}:${slot}`; }
