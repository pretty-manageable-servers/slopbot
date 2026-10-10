import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

const env = { DISCORD_BOT_TOKEN: "test", DISCORD_GUILD_ID: "12345678901234567", DISCORD_CHANNEL_IDS: "12345678901234568", LLM_MODE: "mock" };

test("cooldown defaults and environment settings", () => {
  assert.equal(loadConfig(env).jevCooldownSeconds, 60);
  assert.equal(loadConfig(env).jevMaxRepliesPerHour, 3);
  const config = loadConfig({ ...env, JEV_COOLDOWN_SECONDS: "120", JEV_MAX_REPLIES_PER_HOUR: "5" });
  assert.equal(config.jevCooldownSeconds, 120);
  assert.equal(config.jevMaxRepliesPerHour, 5);
  assert.equal(loadConfig({ ...env, JEV_COOLDOWN_SECONDS: "0" }).jevCooldownSeconds, 0);
});

test("invalid reply limits fail startup with actionable errors", () => {
  for (const value of ["-1", "1.5", "3601", "abc"]) {
    assert.throws(() => loadConfig({ ...env, JEV_COOLDOWN_SECONDS: value }), /JEV_COOLDOWN_SECONDS/);
  }
  assert.throws(() => loadConfig({ ...env, JEV_MAX_REPLIES_PER_HOUR: "1001" }), /JEV_MAX_REPLIES_PER_HOUR/);
});
