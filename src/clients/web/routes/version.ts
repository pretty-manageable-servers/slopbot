import { runtimeVersion } from '../../../operations-config.js';
import { json, type WebApp } from '../env.js';

/** Build version for the console footer. The sha is null unless the image set a valid full git sha. */
export function consoleVersion(env: NodeJS.ProcessEnv = process.env) {
  const { commit, builtAt } = runtimeVersion(env);
  return { sha: commit ? commit.slice(0, 7).toLowerCase() : null, time: builtAt ? new Date(builtAt).toISOString() : null, url: commit ? `https://github.com/pretty-manageable-servers/slopbot/commit/${commit.toLowerCase()}` : null };
}

/** Build version for the footer. Public: it needs no login and holds no secrets. */
export function versionRoutes(app: WebApp): void {
  app.get('/api/version', () => json(200, consoleVersion()));
}
