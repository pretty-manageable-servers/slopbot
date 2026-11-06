import { describe, expect, test } from "vitest";
import { isWindowDays } from "./channels-format";

describe("isWindowDays", () => {
  test("accepts whole days from 1 to 3650", () => {
    expect([1, 3650].map(isWindowDays)).toEqual([true, true]);
    expect([0, 3651, 2.5, Number.NaN].map(isWindowDays)).toEqual([false, false, false, false]);
  });
});
