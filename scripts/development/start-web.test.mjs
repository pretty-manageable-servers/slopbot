import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { checkWebEnv } from './start-web.mjs';

const example = parseEnv(readFileSync(new URL('../../.env.web.example', import.meta.url), 'utf8'));
const ready = { ...example, LLM_API_KEY: 'test-key' };

test('checkWebEnv accepts the example once LLM_API_KEY is filled in', () => {
  assert.equal(checkWebEnv(ready), null);
});

test('checkWebEnv accepts a missing key in mock mode', () => {
  assert.equal(checkWebEnv({ ...ready, LLM_API_KEY: '', LLM_MODE: 'mock' }), null);
});

test('checkWebEnv refuses each unsafe change to a ready env', () => {
  const changes = [
    { SLOPBOT_PLATFORM: 'discord' },
    { DATABASE_URL: 'postgres://slopbot:secret@db.example.com:5432/slopbot' },
    { DISCORD_BOT_TOKEN: 'not-a-real-token' },
    { LLM_API_KEY: '' },
  ];
  for (const change of changes) {
    assert.notEqual(checkWebEnv({ ...ready, ...change }), null, JSON.stringify(change));
  }
});

test('search-start --setup-only writes the SearXNG settings and never calls Docker', () => {
  const root = mkdtempSync(join(tmpdir(), 'slopbot-search-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../search-start.mjs', import.meta.url), join(root, 'scripts', 'search-start.mjs'));
  // With an empty PATH, a Docker call would fail and exit 1.
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'search-start.mjs'), '--setup-only'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(join(root, 'data', 'searxng', 'settings.yml'), 'utf8'), /secret_key: "[0-9a-f]{64}"/);
});
