import { describe, expect, test } from "vitest";
import { avatarSrc, hasWindow, limitError, limitText, money, overrideBody, pageText, serverSummary, sharePct, toMicros, usageText, windowOf } from "./users-format";

const window = (spent: number, limit: number, resetAt: number | null = 1_000) => ({ kind: "5h", spent, limit, resetAt, banked: 0 });

describe("money", () => {
  test("micro-dollars read as dollars with two decimals", () => {
    expect(money(1_234_567)).toBe("$1.23");
    expect(money(0)).toBe("$0.00");
  });

  test("dollar entries become whole micro-dollars", () => {
    expect(toMicros(1.5)).toBe(1_500_000);
    expect(toMicros(0.1)).toBe(100_000);
  });

  test("a limit shows in the field as dollars, and no override is blank", () => {
    expect(limitText(1_500_000)).toBe("1.5");
    expect(limitText(null)).toBe("");
  });
});

describe("limitError", () => {
  test("blank is valid, zero is valid, a dollar amount is valid", () => {
    expect(limitError("")).toBeNull();
    expect(limitError("   ")).toBeNull();
    expect(limitError("0")).toBeNull();
    expect(limitError("12.34")).toBeNull();
  });

  test("negative, not a number, or above the cap is an error", () => {
    expect(limitError("-1")).not.toBeNull();
    expect(limitError("abc")).not.toBeNull();
    expect(limitError("1000001")).not.toBeNull();
  });
});

describe("overrideBody", () => {
  test("a blank entry is null, which is the global limit", () => {
    expect(overrideBody("u1", "", "2.5")).toEqual({ user: "u1", five_hour_cost_micros: null, week_cost_micros: 2_500_000 });
    expect(overrideBody("u1", "5", " ")).toEqual({ user: "u1", five_hour_cost_micros: 5_000_000, week_cost_micros: null });
  });

  test("both blank is the body that removes the override", () => {
    expect(overrideBody("u1", "", "")).toEqual({ user: "u1", five_hour_cost_micros: null, week_cost_micros: null });
  });
});

describe("usage", () => {
  test("a window reads as spent of limit, and says no limit at 0", () => {
    expect(usageText(window(1_234_567, 5_000_000))).toBe("$1.23 of $5.00");
    expect(usageText(window(1_234_567, 0))).toBe("$1.23 of no limit");
  });

  test("the share is whole percent, capped at 100, and 0 with no limit", () => {
    expect(sharePct(window(2, 4))).toBe(50);
    expect(sharePct(window(9, 4))).toBe(100);
    expect(sharePct(window(2, 0))).toBe(0);
  });

  test("a user with no window gets a zero window of that kind", () => {
    const view = { windows: [window(1, 2)] };
    expect(windowOf(view, "week")).toEqual({ kind: "week", spent: 0, limit: 0, resetAt: null, banked: 0 });
    expect(hasWindow(windowOf(view, "week"))).toBe(false);
    expect(hasWindow(windowOf(view, "5h"))).toBe(true);
  });
});

describe("list text", () => {
  test("the page text counts the rows shown", () => {
    expect(pageText(0, 10, 42)).toBe("1–10 of 42");
    expect(pageText(40, 2, 42)).toBe("41–42 of 42");
    expect(pageText(0, 0, 0)).toBe("0 users");
  });

  test("the server list shows two names and the rest as a count", () => {
    expect(serverSummary([{ name: "A" }, { name: "B" }, { name: "C" }])).toEqual({ names: ["A", "B"], more: 1 });
    expect(serverSummary([{ name: "A" }])).toEqual({ names: ["A"], more: 0 });
  });

  test("only Discord's CDN avatars are shown", () => {
    const url = "https://cdn.discordapp.com/avatars/1/a.png";
    expect(avatarSrc(url)).toBe(url);
    expect(avatarSrc("https://evil.example/a.png")).toBeNull();
    expect(avatarSrc(null)).toBeNull();
  });
});
