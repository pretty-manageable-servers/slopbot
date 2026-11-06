import { describe, expect, test } from "vitest";
import { pageLabel } from "./servers-format";

describe("pageLabel", () => {
  test("counts the rows of a full first page", () => {
    expect(pageLabel(0, 20, 45)).toBe("1–20 of 45");
  });

  test("counts the shorter last page up to the total", () => {
    expect(pageLabel(40, 5, 45)).toBe("41–45 of 45");
  });

  test("reads 0 of 0 when no server matches", () => {
    expect(pageLabel(0, 0, 0)).toBe("0 of 0");
  });
});
