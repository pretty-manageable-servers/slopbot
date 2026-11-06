import { describe, expect, test } from "vitest";
import { badNumbers, calibrationArgs, cutoffsFrom, RANGES, toPercent, VOICE_RESET, voiceArgs } from "./server-form";

describe("participation cutoffs", () => {
  test("a snapshot fraction shows as a whole percent", () => {
    expect(toPercent(0.35)).toBe(35);
    expect(toPercent(1)).toBe(100);
    expect(toPercent(0.29)).toBe(29);
  });

  test("the snapshot's cutoffs go back to the calibration setting as percents", () => {
    const cutoffs = cutoffsFrom({ addressed: 0.35, respond: 0.5, unsolicited: 0.9, funny: 0.9 });
    expect(calibrationArgs(cutoffs)).toEqual({ action: "set", addressed: 35, respond: 50, unsolicited: 90, funny: 90 });
  });
});

describe("number fields", () => {
  test("a value above its range is flagged, so Save waits", () => {
    expect(badNumbers([{ label: "Replies per hour", value: 1001, range: RANGES.repliesPerHour }])).toHaveLength(1);
  });

  test("an empty field (NaN) and a fraction are flagged", () => {
    const checks = [NaN, 35.5].map((value) => ({ label: "Addressed, %", value, range: RANGES.cutoff }));
    expect(badNumbers(checks)).toHaveLength(2);
  });

  test("the ends of each range pass", () => {
    const checks = [
      { label: "Participation context, messages", value: 5, range: RANGES.jevContext },
      { label: "Reply context, messages", value: 100, range: RANGES.replyContext },
      { label: "Minimum interval, seconds", value: 0, range: RANGES.cooldownSeconds },
    ];
    expect(badNumbers(checks)).toEqual([]);
  });

  test("participation context stops at 5 but reply context goes to 100", () => {
    expect(badNumbers([{ label: "Participation context, messages", value: 6, range: RANGES.jevContext }])).toHaveLength(1);
    expect(badNumbers([{ label: "Reply context, messages", value: 6, range: RANGES.replyContext }])).toEqual([]);
  });
});

describe("voice instructions", () => {
  test("the text is trimmed before it is saved", () => {
    expect(voiceArgs("  calm and warm \n")).toEqual({ action: "style", instructions: "calm and warm" });
  });

  test("reset saves the word default", () => {
    expect(VOICE_RESET).toEqual({ action: "style", instructions: "default" });
  });
});
