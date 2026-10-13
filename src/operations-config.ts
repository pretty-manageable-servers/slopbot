export interface OperationsConfig {
  servers: string[];
  repository: string;
  githubToken?: string;
  pmsToken?: string;
  project?: string;
  containers: string[];
}

export function loadOperationsConfig(env: NodeJS.ProcessEnv): OperationsConfig | undefined {
  const servers = (env.SLOPBOT_OPERATIONS_GUILD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const githubToken = env.SLOPBOT_GITHUB_TOKEN?.trim();
  const pmsToken = env.SLOPBOT_PMS_TOKEN?.trim();
  if (!servers.length) {
    if (githubToken || pmsToken) throw new Error('Set SLOPBOT_OPERATIONS_GUILD_IDS before enabling operational credentials');
    return undefined;
  }
  if (!servers.every(s => /^\d{17,20}$/.test(s))) throw new Error('SLOPBOT_OPERATIONS_GUILD_IDS must contain Discord server IDs');
  const repository = env.SLOPBOT_GITHUB_REPOSITORY?.trim() || 'pretty-manageable-servers/slopbot';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(s => s === '.' || s === '..')) throw new Error('SLOPBOT_GITHUB_REPOSITORY must be owner/repository');
  const project = env.SLOPBOT_PMS_PROJECT_ID?.trim();
  if (pmsToken && !project) throw new Error('Set SLOPBOT_PMS_PROJECT_ID to the PMServers project ID');
  if (project && !/^[A-Za-z0-9_-]{1,100}$/.test(project)) throw new Error('Invalid SLOPBOT_PMS_PROJECT_ID');
  const containers = (env.SLOPBOT_PMS_CONTAINERS || 'slopbot').split(',').map(s => s.trim()).filter(Boolean);
  if (!containers.length || containers.length > 10 || !containers.every(s => /^[A-Za-z0-9_-]{1,100}$/.test(s))) throw new Error('Invalid SLOPBOT_PMS_CONTAINERS');
  return { servers: [...new Set(servers)], repository, containers, ...(githubToken ? { githubToken } : {}), ...(pmsToken ? { pmsToken } : {}), ...(project ? { project } : {}) };
}

/** Captured when each run starts, rather than inferred from today's production image. */
export function runtimeVersion(env: NodeJS.ProcessEnv = process.env) {
  return { commit: /^[a-f0-9]{40}$/i.test(env.SLOPBOT_BUILD_SHA ?? '') ? env.SLOPBOT_BUILD_SHA! : null,
    builtAt: env.SLOPBOT_BUILD_TIME && Number.isFinite(Date.parse(env.SLOPBOT_BUILD_TIME)) ? env.SLOPBOT_BUILD_TIME : null };
}
