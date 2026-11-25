import { describe, expect, it } from "vitest";
import { frameVars } from "./viewport";

describe("frameVars", () => {
  it("pins the frame to the part above the keyboard", () => {
    expect(frameVars({ height: 401.6, offsetTop: 280.2, scale: 1 })).toEqual({ "--app-height": "402px", "--app-top": "280px" });
  });

  it("leaves the page at full size while the user zooms in", () => {
    expect(frameVars({ height: 300, offsetTop: 120, scale: 2 })).toBeNull();
  });
});
