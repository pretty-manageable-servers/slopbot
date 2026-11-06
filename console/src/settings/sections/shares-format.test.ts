import { describe, expect, test } from "vitest";
import type { ServerShare } from "../../api-types";
import { activeShares, channelLabel, revokedNotice, shareStatus, shareUrl } from "./shares-format";

const id = "Xk3_9fQe-2LmTzWp0aRbVw";
const share = (patch: Partial<ServerShare>): ServerShare => ({ id, channel: "100", created_at: 1, revoked: false, ...patch });

describe("shareUrl", () => {
  test("is the shared chat's page on the console's origin", () => {
    expect(shareUrl("https://slopbot.pmservers.org", id)).toBe(`https://slopbot.pmservers.org/s/${id}`);
  });
});

describe("channelLabel", () => {
  test("shows a channel from the snapshot by its name", () => {
    expect(channelLabel("100", [{ id: "100", name: "general" }])).toBe("#general");
  });

  test("falls back to the channel id when the snapshot does not list it", () => {
    expect(channelLabel("100", [])).toBe("100");
  });
});

describe("share status", () => {
  test("a link is Active until it is revoked", () => {
    expect(shareStatus(share({}))).toBe("Active");
    expect(shareStatus(share({ revoked: true }))).toBe("Revoked");
  });

  test("activeShares leaves out the revoked links", () => {
    expect(activeShares([share({ id: "a" }), share({ id: "b", revoked: true })]).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("revokedNotice", () => {
  test("counts links in the notice, singular for one", () => {
    expect(revokedNotice(1)).toBe("1 link revoked");
    expect(revokedNotice(3)).toBe("3 links revoked");
  });
});
