import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRun, validateWhen } from "../src/schedules/schedule-time.js";
import { DEFAULT_SCHEDULE_LIMITS } from "../src/schedules/schedule-types.js";

const now = new Date("2026-10-14T12:00:00Z");
const limits = DEFAULT_SCHEDULE_LIMITS;

test("invalid schedules are rejected", () => {
  const cases: [Parameters<typeof validateWhen>[0], RegExp][] = [
    [{ kind: "once", at: "2026-10-14T11:00:00Z" }, /future/],
    [{ kind: "once", at: "2026-10-15T11:00:00" }, /timezone/],
    [{ kind: "once", at: "2026-11-14T12:00:01Z" }, /30 days/],
    [{ kind: "cron", cron: "0 9 * *", timezone: "UTC" }, /5 fields/],
    [{ kind: "cron", cron: "x 9 * * *", timezone: "UTC" }, /not valid/],
    [{ kind: "cron", cron: "0 9 * * *", timezone: "Mars/Base" }, /timezone/],
  ];
  for (const [when, error] of cases) assert.throws(() => validateWhen(when, "message", limits, now), error, JSON.stringify(when));
  validateWhen({ kind: "once", at: "2026-11-13T12:00:00Z" }, "message", limits, now);
});

test("interval too short for prompt", () => {
  const when = { kind: "cron", cron: "*/30 * * * *", timezone: "UTC" } as const;
  validateWhen(when, "message", limits, now);
  assert.throws(() => validateWhen(when, "prompt", limits, now), /60 minutes/);
  validateWhen(when, "prompt", { ...limits, minMinutes: { ...limits.minMinutes, prompt: 30 } }, now);
});

test("nextRun weekly London across DST", () => {
  const when = { kind: "cron", cron: "0 9 * * 1", timezone: "Europe/London" } as const;
  assert.equal(nextRun(when, new Date("2026-10-20T00:00:00Z"))?.toISOString(), "2026-10-26T09:00:00.000Z");
  assert.equal(nextRun(when, new Date("2026-10-14T00:00:00Z"))?.toISOString(), "2026-10-19T08:00:00.000Z");
});

test("nextRun once after at is null", () => {
  const when = { kind: "once", at: "2026-10-15T00:00:00Z" } as const;
  assert.equal(nextRun(when, now)?.toISOString(), "2026-10-15T00:00:00.000Z");
  assert.equal(nextRun(when, new Date("2026-10-15T00:00:00Z")), null);
});
