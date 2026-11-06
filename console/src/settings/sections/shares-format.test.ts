import { describe, expect, test } from "vitest";
import type { ServerShare } from "../../api-types";
import { activeShares, shareUrl } from "./shares-format";

const id = "Xk3_9fQe-2LmTzWp0aRbVw";
const share = (patch: Partial<ServerShare>): ServerShare => ({ id, channel: "100", created_at: 1, revoked: false, ...patch });

describe("shares", () => {
  test("a link is the shared chat's page on the console's origin", () => {
    expect(shareUrl("https://slopbot.pmservers.org", id)).toBe(`https://slopbot.pmservers.org/s/${id}`);
  });

  test("revoked links are not listed as active", () => {
    expect(activeShares([share({ id: "a" }), share({ id: "b", revoked: true })]).map((s) => s.id)).toEqual(["a"]);
  });
});
