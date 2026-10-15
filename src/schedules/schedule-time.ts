import { CronExpressionParser } from "cron-parser";
import type { Json } from "../domain.js";
import { ToolError } from "../errors.js";
import { DEFAULT_SCHEDULE_LIMITS, FREE_PLAN_SCHEDULE_DAYS, MAX_MIN_MINUTES, MAX_SCHEDULE_LIMIT, type ScheduleActionKind, type ScheduleLimits, type ScheduleWhen } from "./schedule-types.js";

const DAY_MS = 86_400_000;
const OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;

function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

function cron(when: Extract<ScheduleWhen, { kind: "cron" }>, after: Date) {
  return CronExpressionParser.parse(when.cron, { currentDate: after, tz: when.timezone });
}

/** Throws ToolError when the time is not valid for this action kind. */
export function validateWhen(when: ScheduleWhen, action: ScheduleActionKind, limits: ScheduleLimits, now: Date): void {
  if (when.kind === "once") {
    if (!OFFSET.test(when.at)) throw new ToolError("The time needs a timezone, for example 2026-10-20T09:00:00Z or +02:00.");
    const at = Date.parse(when.at);
    if (!Number.isFinite(at)) throw new ToolError("The time is not a valid ISO timestamp.");
    if (at <= now.getTime()) throw new ToolError("The time must be in the future.");
    if (at - now.getTime() > FREE_PLAN_SCHEDULE_DAYS * DAY_MS) throw new ToolError(`The time must be at most ${FREE_PLAN_SCHEDULE_DAYS} days ahead.`);
    return;
  }
  if (when.cron.trim().split(/\s+/).length !== 5) throw new ToolError("The cron must have 5 fields: minute hour day month weekday.");
  if (!validZone(when.timezone)) throw new ToolError(`Unknown timezone "${when.timezone}". Use an IANA name, for example Europe/London.`);
  let first: number, second: number;
  try {
    const expression = cron(when, now);
    first = expression.next().getTime();
    second = expression.next().getTime();
  } catch { throw new ToolError("The cron is not valid."); }
  const min = limits.minMinutes[action];
  if (second - first < min * 60_000) throw new ToolError(`A ${action} schedule must run at most once every ${min} minutes.`);
}

/** The next run strictly after `after`, or null when there are no more runs. */
export function nextRun(when: ScheduleWhen, after: Date): Date | null {
  if (when.kind === "once") {
    const at = Date.parse(when.at);
    return at > after.getTime() ? new Date(at) : null;
  }
  return new Date(cron(when, after).next().getTime());
}

function whole(value: unknown, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : fallback;
}

/** Parses the stored setting. Each missing or bad field takes its default. */
export function scheduleLimits(value: Json | undefined): ScheduleLimits {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, Json>;
  const min = (raw.minMinutes && typeof raw.minMinutes === "object" && !Array.isArray(raw.minMinutes) ? raw.minMinutes : {}) as Record<string, Json>;
  const d = DEFAULT_SCHEDULE_LIMITS;
  return {
    perServer: whole(raw.perServer, MAX_SCHEDULE_LIMIT, d.perServer),
    perUser: whole(raw.perUser, MAX_SCHEDULE_LIMIT, d.perUser),
    minMinutes: {
      message: whole(min.message, MAX_MIN_MINUTES, d.minMinutes.message),
      prompt: whole(min.prompt, MAX_MIN_MINUTES, d.minMinutes.prompt),
      tool: whole(min.tool, MAX_MIN_MINUTES, d.minMinutes.tool),
    },
  };
}
