import assert from "node:assert/strict";
import { test } from "node:test";
import { discordStartupError } from "../src/startup-error.js";

test("startup errors never print raw error details", () => {
  assert.ok(!discordStartupError(new Error("private request headers here")).includes("private"));
});
