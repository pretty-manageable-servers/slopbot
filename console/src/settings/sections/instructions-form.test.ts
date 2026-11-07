import { describe, expect, test } from "vitest";
import { ApiError } from "../../api";
import { canSave, instructionsLength, rejectMessage } from "./instructions-form";

describe("instructionsLength", () => {
  test("counts an emoji as one character, as the bot does", () => {
    expect(instructionsLength("🙂🙂")).toBe(2);
    expect(instructionsLength("ok 🙂")).toBe(4);
  });
});

describe("canSave", () => {
  test("is false when the draft is the saved text", () => {
    expect(canSave("Be brief.", "Be brief.", 100, false)).toBe(false);
    expect(canSave("", null, 100, false)).toBe(false);
  });

  test("is false when the draft is over the limit or a save is running", () => {
    expect(canSave("abcd", "ab", 3, false)).toBe(false);
    expect(canSave("Be brief.", "", 100, true)).toBe(false);
  });

  test("is true for a changed draft that fits", () => {
    expect(canSave("Be brief.", "", 100, false)).toBe(true);
    expect(canSave("Be brief. 🙂", "Be brief.", 11, false)).toBe(true);
  });

  test("is true for clearing a saved text", () => {
    expect(canSave("", "Be brief.", 100, false)).toBe(true);
  });
});

describe("rejectMessage", () => {
  test("gives the bot's text for a 422 rejection", () => {
    const error = new ApiError("That text was flagged.", 422, { reason: "flagged" });
    expect(rejectMessage(error)).toBe("That text was flagged.");
  });

  test("is null for other server errors and for anything that is not an ApiError", () => {
    expect(rejectMessage(new ApiError("Server error.", 500))).toBeNull();
    expect(rejectMessage(new Error("Network down."))).toBeNull();
  });
});
