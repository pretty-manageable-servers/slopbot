import { describe, expect, test } from "vitest";
import { badNumbers, calibrationArgs, cutoffsFrom, RANGES } from "./server-form";

describe("participation cutoffs", () => {
  test("the snapshot's cutoffs go back to the calibration setting as percents", () => {
    const cutoffs = cutoffsFrom({ addressed: 0.35, respond: 0.5, unsolicited: 0.9, funny: 0.9 });
    expect(calibrationArgs(cutoffs)).toEqual({ action: "set", addressed: 35, respond: 50, unsolicited: 90, funny: 90 });
  });
});

describe("number fields", () => {
  test("out-of-range, empty and fractional values are flagged, range ends pass", () => {
    const flagged = [
      { label: "Replies per hour", value: 1001, range: RANGES.repliesPerHour },
      { label: "Addressed, %", value: NaN, range: RANGES.cutoff },
      { label: "Addressed, %", value: 35.5, range: RANGES.cutoff },
      { label: "Participation context, messages", value: 6, range: RANGES.jevContext },
    ];
    expect(badNumbers(flagged)).toHaveLength(flagged.length);
    const ok = [
      { label: "Participation context, messages", value: 5, range: RANGES.jevContext },
      { label: "Reply context, messages", value: 100, range: RANGES.replyContext },
      { label: "Minimum interval, seconds", value: 0, range: RANGES.cooldownSeconds },
    ];
    expect(badNumbers(ok)).toEqual([]);
  });
});
