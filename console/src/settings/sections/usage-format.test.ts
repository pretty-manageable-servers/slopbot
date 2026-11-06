import { describe, expect, test } from "vitest";
import { resetsLabel, usageLevel, windowName } from "./usage-format";

const now = Date.UTC(2026, 10, 5, 12, 0);
const minutesAhead = (minutes: number) => now + minutes * 60_000;

describe("resetsLabel", () => {
  test("over a day shows days and hours", () => {
    expect(resetsLabel(minutesAhead(3 * 1440 + 4 * 60), now)).toBe("Resets in 3d 4h");
  });

  test("under a day shows hours and minutes", () => {
    expect(resetsLabel(minutesAhead(2 * 60 + 15), now)).toBe("Resets in 2h 15m");
  });
});

describe("usageLevel", () => {
  test("49 percent is still the accent color", () => {
    expect(usageLevel(49)).toBe("low");
  });

  test("50 percent turns to the warning color", () => {
    expect(usageLevel(50)).toBe("mid");
  });

  test("80 percent turns to the danger color", () => {
    expect(usageLevel(80)).toBe("high");
  });
});

describe("windowName", () => {
  test("names the 5-hour and weekly windows, and keeps other kinds", () => {
    expect([windowName("5h"), windowName("week"), windowName("month")]).toEqual(["5-hour", "Weekly", "month"]);
  });
});
