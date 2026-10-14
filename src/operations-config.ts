import { createPrivateKey } from 'node:crypto';

export interface OperationsConfig {
  servers: string[];
  repository: string;
  githubToken?: string;
  githubApp?: { id: string; installationId: string; privateKey: string };
  pmsToken?: string;
  project?: string;
  containers: string[];
}

export function loadOperationsConfig(env: NodeJS.ProcessEnv): OperationsConfig | undefined {
  const servers = (env.SLOPBOT_OPERATIONS_GUILD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const githubToken = env.SLOPBOT_GITHUB_TOKEN?.trim();
  const id = env.SLOPBOT_GITHUB_APP_ID?.trim();
  const installationId = env.SLOPBOT_GITHUB_APP_INSTALLATION_ID?.trim();
  const privateKey = env.SLOPBOT_GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  let githubApp: OperationsConfig['githubApp'];
  if (id || installationId || privateKey) {
    if (!id || !installationId || !privateKey) throw new Error('Set SLOPBOT_GITHUB_APP_ID, SLOPBOT_GITHUB_APP_INSTALLATION_ID and SLOPBOT_GITHUB_APP_PRIVATE_KEY together');
    if (!/^\d+$/.test(id) || !/^\d+$/.test(installationId)) throw new Error('GitHub App and installation IDs must be numeric');
    if (githubToken) throw new Error('Configure GitHub App credentials or SLOPBOT_GITHUB_TOKEN, not both');
    try { if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw new Error(); }
    catch { throw new Error('SLOPBOT_GITHUB_APP_PRIVATE_KEY must be an RSA private key in PEM format'); }
    githubApp = { id, installationId, privateKey };
  }
  const pmsToken = env.SLOPBOT_PMS_TOKEN?.trim();
  if (!servers.length && !githubToken && !githubApp && !pmsToken) return undefined;
  if (pmsToken && !servers.length) throw new Error('Set SLOPBOT_OPERATIONS_GUILD_IDS before enabling infrastructure diagnostics');
  if (!servers.every(s => /^\d{17,20}$/.test(s))) throw new Error('SLOPBOT_OPERATIONS_GUILD_IDS must contain Discord server IDs');
  const repository = env.SLOPBOT_GITHUB_REPOSITORY?.trim() || 'pretty-manageable-servers/slopbot';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(s => s === '.' || s === '..')) throw new Error('SLOPBOT_GITHUB_REPOSITORY must be owner/repository');
  const project = env.SLOPBOT_PMS_PROJECT_ID?.trim();
  if (pmsToken && !project) throw new Error('Set SLOPBOT_PMS_PROJECT_ID to the PMServers project ID');
  if (project && !/^[A-Za-z0-9_-]{1,100}$/.test(project)) throw new Error('Invalid SLOPBOT_PMS_PROJECT_ID');
  const containers = (env.SLOPBOT_PMS_CONTAINERS || 'slopbot').split(',').map(s => s.trim()).filter(Boolean);
  if (!containers.length || containers.length > 10 || !containers.every(s => /^[A-Za-z0-9_-]{1,100}$/.test(s))) throw new Error('Invalid SLOPBOT_PMS_CONTAINERS');
  return { servers: [...new Set(servers)], repository, containers, ...(githubToken ? { githubToken } : {}), ...(githubApp ? { githubApp } : {}), ...(pmsToken ? { pmsToken } : {}), ...(project ? { project } : {}) };
}

/** Captured when each run starts, rather than inferred from today's production image. */
export function runtimeVersion(env: NodeJS.ProcessEnv = process.env) {
  return { commit: /^[a-f0-9]{40}$/i.test(env.SLOPBOT_BUILD_SHA ?? '') ? env.SLOPBOT_BUILD_SHA! : null,
    builtAt: env.SLOPBOT_BUILD_TIME && Number.isFinite(Date.parse(env.SLOPBOT_BUILD_TIME)) ? env.SLOPBOT_BUILD_TIME : null };
}
