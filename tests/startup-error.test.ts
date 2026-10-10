import assert from "node:assert/strict";
import { test } from "node:test";
import { discordStartupError } from "../src/startup-error.js";

test("disallowed intents give the exact setting to enable", () => {
  assert.match(discordStartupError(new Error("Used disallowed intents")), /enable Message Content Intent/);
});

test("network errors are not reported as invalid credentials", () => {
  assert.match(discordStartupError({ code: "ENOTFOUND" }), /network\/DNS/);
  assert.match(discordStartupError({ cause: { code: "ETIMEDOUT" } }), /network\/DNS/);
});

test("invalid tokens are classified without printing raw error details", () => {
  assert.match(discordStartupError({ code: "TokenInvalid" }), /rejected the bot token/);
  assert.ok(!discordStartupError(new Error("private request headers here")).includes("private"));
});
