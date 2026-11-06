import { describe, expect, test } from "vitest";
import { avatarSrc, limitError, overrideBody, toMicros } from "./users-format";

describe("per-user limits", () => {
  test("dollar entries become whole micro-dollars", () => {
    expect(toMicros(1.5)).toBe(1_500_000);
    expect(toMicros(0.1)).toBe(100_000);
  });

  test("blank, zero and a dollar amount are valid; negative, text and above the cap are not", () => {
    for (const ok of ["", "   ", "0", "12.34"]) expect(limitError(ok)).toBeNull();
    for (const bad of ["-1", "abc", "1000001"]) expect(limitError(bad)).not.toBeNull();
  });

  test("a blank entry is null (the global limit), so both blank removes the override", () => {
    expect(overrideBody("u1", "", "2.5")).toEqual({ user: "u1", five_hour_cost_micros: null, week_cost_micros: 2_500_000 });
    expect(overrideBody("u1", "", "")).toEqual({ user: "u1", five_hour_cost_micros: null, week_cost_micros: null });
  });
});

describe("avatars", () => {
  test("only Discord's CDN avatars are shown", () => {
    const url = "https://cdn.discordapp.com/avatars/1/a.png";
    expect(avatarSrc(url)).toBe(url);
    expect(avatarSrc("https://evil.example/a.png")).toBeNull();
    expect(avatarSrc(null)).toBeNull();
  });
});
