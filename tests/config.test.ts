import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

const env = { DISCORD_BOT_TOKEN: "test", DISCORD_GUILD_ID: "12345678901234567", DISCORD_CHANNEL_IDS: "12345678901234568", LLM_MODE: "mock" };

test("reply budgets follow documented model limits and retain room for input", () => {
  const nimbus = loadConfig(env);
  assert.equal(nimbus.outputTokens, 50000);
  assert.equal(nimbus.contextTokens, 200000);
  assert.equal(nimbus.checkpointTokens, 2048);
  for (const model of ["cirrus", "gemma4-e4b"]) {
    const config = loadConfig({ ...env, LLM_MODEL: model });
    assert.equal(config.outputTokens, 32000); assert.equal(config.contextTokens, 64000);
  }
  assert.equal(loadConfig({ ...env, LLM_MODEL: "qwen3.8-flash-next" }).outputTokens, 50000);
  assert.throws(() => loadConfig({ ...env, OUTPUT_TOKENS: "65536" }), /nimbus maximum output of 50000/);
  assert.throws(() => loadConfig({ ...env, LLM_MODEL: "cirrus", CONTEXT_TOKENS: "200000" }), /cirrus context window of 64000/);
  assert.throws(() => loadConfig({ ...env, CONTEXT_TOKENS: "50000" }), /OUTPUT_TOKENS must leave room/);
  assert.equal(loadConfig({ ...env, CONTEXT_TOKENS: "32768", OUTPUT_TOKENS: "2048" }).outputTokens, 2048);
  assert.equal(loadConfig({ ...env, LLM_BASE_URL: "https://example.com/v1", OUTPUT_TOKENS: "65536" }).outputTokens, 65536);
});

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
