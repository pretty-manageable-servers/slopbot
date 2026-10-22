import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRun, validateWhen } from "../src/schedules/schedule-time.js";
import { DEFAULT_SCHEDULE_LIMITS } from "../src/schedules/schedule-types.js";

const now = new Date("2026-10-14T12:00:00Z");
const limits = DEFAULT_SCHEDULE_LIMITS;

test("validateWhen rejects bad schedules and accepts the boundary", () => {
  const rejected: [string, Parameters<typeof validateWhen>[0], "message" | "prompt"][] = [
    ["once in the past", { kind: "once", at: "2026-10-14T11:00:00Z" }, "message"],
    ["once without offset", { kind: "once", at: "2026-10-15T11:00:00" }, "message"],
    ["once beyond 30 days", { kind: "once", at: "2026-11-14T12:00:01Z" }, "message"],
    ["cron with 4 fields", { kind: "cron", cron: "0 9 * *", timezone: "UTC" }, "message"],
    ["cron with bad field", { kind: "cron", cron: "x 9 * * *", timezone: "UTC" }, "message"],
    ["unknown timezone", { kind: "cron", cron: "0 9 * * *", timezone: "Mars/Base" }, "message"],
    ["prompt every 30 minutes", { kind: "cron", cron: "*/30 * * * *", timezone: "UTC" }, "prompt"],
  ];
  for (const [name, when, kind] of rejected) assert.throws(() => validateWhen(when, kind, limits, now), name);
  validateWhen({ kind: "once", at: "2026-11-13T12:00:00Z" }, "message", limits, now);
  validateWhen({ kind: "cron", cron: "*/30 * * * *", timezone: "UTC" }, "message", limits, now);
});

test("nextRun follows the timezone across DST and ends once schedules", () => {
  const weekly = { kind: "cron", cron: "0 9 * * 1", timezone: "Europe/London" } as const;
  const once = { kind: "once", at: "2026-10-15T00:00:00Z" } as const;
  const cases: [string, Parameters<typeof nextRun>[0], Date, string | null][] = [
    ["weekly London after DST change", weekly, new Date("2026-10-20T00:00:00Z"), "2026-10-26T09:00:00.000Z"],
    ["weekly London before DST change", weekly, new Date("2026-10-14T00:00:00Z"), "2026-10-19T08:00:00.000Z"],
    ["once before its time", once, now, "2026-10-15T00:00:00.000Z"],
    ["once at its time", once, new Date("2026-10-15T00:00:00Z"), null],
  ];
  for (const [name, when, from, expected] of cases) assert.equal(nextRun(when, from)?.toISOString() ?? null, expected, name);
});
