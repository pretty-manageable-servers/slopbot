import type { Json } from '../domain.js';
import type { OperationsConfig } from '../operations-config.js';
import { redactErrorText, ToolError } from '../errors.js';

export interface Issue { number: number; title: string; body: string | null; state: string; html_url: string; updated_at?: string; pull_request?: unknown }
export interface PullRequest { number: number; title: string; state: string; merged: boolean; merge_commit_sha: string | null; html_url: string; head: { sha: string } }
export interface WorkflowRun { id: number; name: string; head_sha: string; status: string; conclusion: string | null; html_url: string; created_at: string; updated_at: string }
export interface Container { id: string; name: string; image: string; status: string; status_message?: string; created_at: string; updated_at: string }
export interface OperationsClient {
  repository: string;
  searchIssues(query: string): Promise<{ items: Issue[]; total: number }>;
  issue(number: number): Promise<Issue>;
  comments(number: number, page?: number): Promise<Issue[]>;
  createIssue(title: string, body: string): Promise<Issue>;
  comment(number: number, body: string): Promise<Issue>;
  findIssue(marker: string): Promise<Issue | undefined>;
  findComment(number: number, marker: string): Promise<Issue | undefined>;
  file(path: string, ref: string): Promise<string>;
  runs(sha?: string): Promise<WorkflowRun[]>;
  jobs(run: number): Promise<Json>;
  jobLogs(job: number): Promise<{ text: string; truncated: boolean }>;
  pull(number: number): Promise<PullRequest>;
  relatedPulls(number: number): Promise<number[]>;
  containsCommit(base: string, head: string): Promise<boolean>;
  containers(): Promise<Container[]>;
  logs(container: string, tail: number, previous: boolean): Promise<{ time: string; message: string }[]>;
  events(): Promise<{ id: string; time: string; level: string; resource_id: string; resource_name: string; message: string }[]>;
}

export async function boundedBody(response: Response, max = 1024 * 1024, truncate = false): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Uint8Array[] = []; let bytes = 0; let truncated = false;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      const remaining = max - bytes;
      chunks.push(next.value.subarray(0, remaining)); bytes += Math.min(remaining, next.value.length);
      if (next.value.length > remaining) { truncated = true; break; }
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (truncated && !truncate) throw new Error('Operational response exceeded its size limit');
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** Fixed API origins, fixed repository, GET-only PMServers. No shell or general HTTP tool. */
export class HttpOperationsClient implements OperationsClient {
  readonly repository: string;
  constructor(private readonly config: OperationsConfig, private readonly fetcher: typeof fetch = fetch) { this.repository = config.repository; }
  private async response(path: string, method = 'GET', body?: Json): Promise<Response> {
    const token = this.config.githubToken;
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'slopbot-operations', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok && response.status !== 302) {
      await response.body?.cancel();
      // Server failures after a POST can have an unknown outcome. Leave them for reconciliation.
      if (method !== 'GET' && response.status >= 500) throw new Error(`GitHub write returned HTTP ${response.status}`);
      throw new ToolError(`GitHub returned HTTP ${response.status}. Check repository access, permissions, rate limits, or log retention.`, 'failed');
    }
    if (method !== 'GET' && response.status === 302) { await response.body?.cancel(); throw new Error('Unexpected redirect after GitHub write'); }
    return response;
  }
  private async gh<T>(suffix: string, method = 'GET', body?: Json): Promise<T> {
    const response = await this.response(`/repos/${this.repository}${suffix}`, method, body);
    if (response.status === 302) { await response.body?.cancel(); throw new ToolError('Unexpected GitHub API redirect'); }
    return JSON.parse((await boundedBody(response)).text) as T;
  }
  async searchIssues(query: string) {
    const q = `repo:${this.repository} is:issue ${query.replace(/\b(?:repo|org|user):\S+|\bis:(?:pr|issue)\b/gi, '')}`;
    const response = await this.response(`/search/issues?q=${encodeURIComponent(q)}&per_page=20`);
    const data = JSON.parse((await boundedBody(response)).text) as { items: Issue[]; total_count: number };
    return { items: data.items.filter(i => !i.pull_request && i.html_url.startsWith(`https://github.com/${this.repository}/issues/`)), total: data.total_count };
  }
  issue(number: number) { return this.gh<Issue>(`/issues/${number}`); }
  comments(number: number, page = 1) { return this.gh<Issue[]>(`/issues/${number}/comments?per_page=100&page=${page}`); }
  createIssue(title: string, body: string) {
    if (!this.config.githubToken) throw new ToolError('Configure SLOPBOT_GITHUB_TOKEN with Issues write permission');
    return this.gh<Issue>('/issues', 'POST', { title, body });
  }
  comment(number: number, body: string) {
    if (!this.config.githubToken) throw new ToolError('Configure SLOPBOT_GITHUB_TOKEN with Issues write permission');
    return this.gh<Issue>(`/issues/${number}/comments`, 'POST', { body });
  }
  async findIssue(marker: string) {
    // Do not rely on search indexing for recovery. Absence never authorizes another POST.
    for (let page = 1; page <= 10; page++) {
      const issues = await this.gh<Issue[]>(`/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`);
      const found = issues.find(i => !i.pull_request && i.body?.includes(marker)); if (found) return found;
      if (issues.length < 100) break;
    }
    return undefined;
  }
  async findComment(number: number, marker: string) {
    for (let page = 1; page <= 10; page++) {
      const comments = await this.comments(number, page);
      const found = comments.find(i => i.body?.includes(marker)); if (found) return found;
      if (comments.length < 100) break;
    }
    return undefined;
  }
  async file(path: string, ref: string) {
    const data = await this.gh<{ encoding: string; content: string }>(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
    if (data.encoding !== 'base64') throw new ToolError('Repository file is too large or unsupported');
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  async runs(sha?: string) { return (await this.gh<{ workflow_runs: WorkflowRun[] }>(`/actions/workflows/deploy.yml/runs?per_page=20${sha ? `&head_sha=${encodeURIComponent(sha)}` : ''}`)).workflow_runs; }
  async jobs(run: number) { return this.gh<Json>(`/actions/runs/${run}/jobs?per_page=100`); }
  async jobLogs(job: number) {
    let response = await this.response(`/repos/${this.repository}/actions/jobs/${job}/logs`);
    if (response.status === 302) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new ToolError('GitHub did not supply a log download location');
      const url = new URL(location);
      if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com'))) throw new ToolError('GitHub supplied an unsupported log download host');
      // Signed download receives no GitHub credential. Never follow another redirect.
      response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new ToolError(`GitHub log download returned HTTP ${response.status}`, 'failed'); }
    }
    return boundedBody(response, 256 * 1024, true);
  }
  pull(number: number) { return this.gh<PullRequest>(`/pulls/${number}`); }
  async relatedPulls(number: number) {
    const timeline = await this.gh<{ event: string; source?: { issue?: { html_url?: string; pull_request?: unknown } } }[]>(`/issues/${number}/timeline?per_page=100`);
    const prefix = `https://github.com/${this.repository}/pull/`;
    return [...new Set(timeline.filter(e => e.event === 'cross-referenced').flatMap(e => {
      const url = e.source?.issue?.html_url;
      if (!url?.startsWith(prefix) || !/^\d+$/.test(url.slice(prefix.length))) return [];
      return [Number(url.slice(prefix.length))];
    }))].slice(-10);
  }
  async containsCommit(base: string, head: string) {
    if (!/^[a-f0-9]{40}$/i.test(base) || !/^[a-f0-9]{40}$/i.test(head)) return false;
    if (base === head) return true;
    const result = await this.gh<{ status: string }>(`/compare/${base}...${head}`);
    return ['ahead', 'identical'].includes(result.status);
  }
  private async pms<T>(suffix: string): Promise<T> {
    if (!this.config.pmsToken || !this.config.project) throw new ToolError('Configure SLOPBOT_PMS_TOKEN and SLOPBOT_PMS_PROJECT_ID for live infrastructure diagnostics');
    const response = await this.fetcher(`https://api.pmservers.org/v1/projects/${encodeURIComponent(this.config.project)}${suffix}`, {
      headers: { Authorization: `Bearer ${this.config.pmsToken}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new ToolError(`PMServers returned HTTP ${response.status}`, 'failed'); }
    return JSON.parse((await boundedBody(response)).text) as T;
  }
  async containers() {
    const data = await this.pms<{ items: Container[] }>('/containers');
    return data.items.filter(c => this.config.containers.includes(c.name) || this.config.containers.includes(c.id)).map(c => ({ id: c.id, name: c.name, image: redactErrorText(c.image), status: c.status, ...(c.status_message ? { status_message: redactErrorText(c.status_message) } : {}), created_at: c.created_at, updated_at: c.updated_at }));
  }
  async logs(container: string, tail: number, previous: boolean) {
    const selected = (await this.containers()).find(c => c.name === container || c.id === container);
    if (!selected) throw new ToolError('Container is outside the configured diagnostic allowlist');
    return (await this.pms<{ lines: { time: string; message: string }[] }>(`/containers/${encodeURIComponent(selected.id)}/logs?tail=${Math.min(500, Math.max(1, tail))}${previous ? '&previous=true' : ''}`)).lines;
  }
  async events() {
    const ids = new Set((await this.containers()).map(c => c.id));
    return (await this.pms<{ items: { id: string; time: string; level: string; resource_id: string; resource_name: string; message: string }[] }>('/events')).items.filter(e => ids.has(e.resource_id));
  }
}
