// Local console without Discord: local Postgres and SearXNG in Docker, the web console on the fixture world, and dev-oauth for sign-in.
import { readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

const file = '.env.web';
const localHosts = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/** Returns the reason the local console must not start with this env, or null when it may start. */
export function checkWebEnv(env) {
  if (env.SLOPBOT_PLATFORM?.trim() !== 'local') return 'Set SLOPBOT_PLATFORM=local in .env.web.';
  let host = '';
  try { host = new URL(env.DATABASE_URL ?? '').hostname.toLowerCase(); } catch { /* reported below */ }
  if (!localHosts.includes(host)) return 'DATABASE_URL must point at the local Postgres on 127.0.0.1:5433.';
  if (env.DISCORD_BOT_TOKEN?.trim()) return 'Remove DISCORD_BOT_TOKEN: local mode never logs in to Discord.';
  if (!env.LLM_API_KEY?.trim() && env.LLM_MODE !== 'mock') return 'Set LLM_API_KEY in .env.web, or LLM_MODE=mock.';
  return null;
}

function main() {
  if (!existsSync(file)) {
    console.error('Copy .env.web.example to .env.web and set LLM_API_KEY.');
    process.exit(1);
  }
  const env = parseEnv(readFileSync(file, 'utf8'));
  // Check the shell too: spawned children inherit it, so a token exported there would log the bot in.
  const problem = checkWebEnv({ ...process.env, ...env });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  if (spawnSync(process.execPath, ['scripts/search-start.mjs', '--setup-only'], { stdio: 'inherit' }).status !== 0) process.exit(1);
  const services = spawnSync('docker', ['compose', '-f', 'compose.development.yaml', 'up', '-d', '--wait', 'postgres', 'searxng'], { stdio: 'inherit' });
  if (services.error || services.status !== 0) {
    console.error('Start Docker (OrbStack), then run pnpm dev:web again.');
    process.exit(1);
  }
  if (spawnSync('pnpm', ['run', 'build'], { stdio: 'inherit' }).status !== 0) process.exit(1);

  const options = { stdio: 'inherit', env: { ...process.env, ...env, NODE_ENV: 'development' } };
  const compiler = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], options);
  const web = spawn(process.execPath, ['--watch', 'dist/src/web-main.js'], options);
  const oauth = spawn(process.execPath, ['scripts/development/dev-oauth.mjs'], options);
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    compiler.kill('SIGTERM');
    web.kill('SIGTERM');
    oauth.kill('SIGTERM');
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (const child of [compiler, web, oauth]) {
    child.on('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
    child.on('exit', code => { if (!stopping) { process.exitCode = code || 0; stop(); } });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
