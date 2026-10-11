import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
export function tunnelOptions(env) {
  if (env.PMS_DB_TUNNEL !== 'true') return undefined;
  const url = new URL(env.DATABASE_URL);
  const port = Number(env.PMS_DB_PORT ?? 15432);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port || 5432) !== port) throw new Error('DATABASE_URL must use the configured localhost PMS_DB_PORT.');
  if (!env.PMS_CLI_PATH || !env.PMS_SSH_KEY) throw new Error('Set PMS_CLI_PATH and PMS_SSH_KEY for the database tunnel.');
  return { port, executable: resolve(env.PMS_CLI_PATH), args: ['--yes', '--project', env.PMS_PROJECT ?? 'slop', 'db', 'connect', env.PMS_DB_ID ?? 'slopbot', '--port', String(port), '--identity', resolve(env.PMS_SSH_KEY)] };
}
const listening = port => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  const done = value => { socket.destroy(); resolve(value); };
  socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(500, () => done(false));
});
export async function startDatabaseTunnel(env) {
  const options = tunnelOptions(env);
  if (!options) return { stop() {} };
  if (await listening(options.port)) { console.log(`Using existing database tunnel on localhost:${options.port}.`); return { stop() {} }; }
  const child = spawn(options.executable, options.args, { detached: true, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...env, ...(env.PMS_CONFIG_DIR ? { PMS_CONFIG_DIR: resolve(env.PMS_CONFIG_DIR) } : {}), ...(env.E2B_API_KEY && !env.PMS_TOKEN ? { PMS_TOKEN: env.E2B_API_KEY } : {}) } });
  let ended = false, failure;
  child.once('exit', () => { ended = true; }); child.once('error', error => { ended = true; failure = error; });
  const stop = () => { if (!ended && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (let i = 0; i < 240; i++) {
      if (ended) throw new Error(failure ? 'PMServers CLI could not start.' : 'Database tunnel exited before startup. Check PMServers login and registered SSH key.');
      if (await listening(options.port)) { console.log(`Database tunnel ready on localhost:${options.port}.`); return { child, stop }; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Database tunnel startup timed out.');
  } catch (error) { stop(); throw error; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
