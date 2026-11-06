import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

const env = { DISCORD_BOT_TOKEN: "test", DISCORD_GUILD_ID: "12345678901234567", DISCORD_CHANNEL_IDS: "12345678901234568", LLM_MODE: "mock" };

test("invalid reply limits fail startup with actionable errors", () => {
  for (const value of ["-1", "1.5", "3601", "abc"]) {
    assert.throws(() => loadConfig({ ...env, JEV_COOLDOWN_SECONDS: value }), /JEV_COOLDOWN_SECONDS/);
  }
  assert.throws(() => loadConfig({ ...env, JEV_MAX_REPLIES_PER_HOUR: "1001" }), /JEV_MAX_REPLIES_PER_HOUR/);
});

test('object storage uses PMServers path-style settings and requires a dedicated bucket and credentials', () => {
  assert.equal(loadConfig(env).objectStorage, undefined);
  assert.throws(() => loadConfig({ ...env, OBJECT_STORAGE_BUCKET: 'slopbot-files' }), /AWS_ACCESS_KEY_ID/);
  const storageEnv = { ...env, OBJECT_STORAGE_BUCKET: 'slopbot-files', AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret' };
  const storage = loadConfig(storageEnv).objectStorage!;
  assert.equal(storage.endpoint, 'https://s3.pmservers.org'); assert.equal(storage.region, 'pms');
  assert.equal(loadConfig({ ...storageEnv, AWS_ENDPOINT_URL: 'http://garage.pms-storage.svc:3900' }).objectStorage!.publicEndpoint, 'https://s3.pmservers.org');
  for (const endpoint of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?secret=value']) assert.throws(() => loadConfig({ ...storageEnv, AWS_ENDPOINT_URL: endpoint }));
  assert.throws(() => loadConfig({ ...storageEnv, OBJECT_STORAGE_PUBLIC_ENDPOINT: 'http://garage.pms-storage.svc:3900' }), /HTTPS/);
});

test("servers: empty allowlist allows all, initial channels need their server", () => {
  const base = { DISCORD_BOT_TOKEN: "test", LLM_MODE: "mock" };
  assert.deepEqual(loadConfig(base).guildIds, []);
  assert.deepEqual(loadConfig({ ...base, DISCORD_GUILD_IDS: "12345678901234567, 12345678901234569" }).guildIds, ["12345678901234567", "12345678901234569"]);
  assert.deepEqual(loadConfig({ ...base, DISCORD_GUILD_ID: "12345678901234567" }).guildIds, []);
  assert.throws(() => loadConfig({ ...base, DISCORD_CHANNEL_IDS: "12345678901234568" }), /DISCORD_GUILD_ID/);
  assert.throws(() => loadConfig({ ...base, DISCORD_GUILD_IDS: "my-server" }), /numeric IDs/);
});
