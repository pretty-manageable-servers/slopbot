import { ToolError } from '../tools.js';
import { requestTimings } from "../request-timing.js";
import type { SearchHit, WebSearch } from '../web-search.js';
export class SearxNGSearch implements WebSearch {
  private readonly endpoint: URL;
  private requests: number[] = [];
  constructor(baseUrl: string, private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now, private readonly access?: { clientId: string; clientSecret: string }) {
    const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('SEARXNG_URL must be an HTTP(S) base URL without credentials, query or fragment');
    if (access && (base.protocol !== 'https:' || !access.clientId || !access.clientSecret)) throw new Error('Protected search requires HTTPS and both Cloudflare Access credentials');
    this.endpoint = new URL('search', base);
  }
  async search(query: string, limit: number): Promise<readonly SearchHit[]> {
    if (!query.trim() || query.length > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new ToolError('Invalid search query or result limit');
    const now = this.now(); this.requests = this.requests.filter(time => time > now - 60000);
    if (this.requests.length >= 30) throw new ToolError('Search limit reached. Retry in a minute.');
    this.requests.push(now);
    const url = new URL(this.endpoint); url.searchParams.set('q', query); url.searchParams.set('format', 'json'); url.searchParams.set('safesearch', '1');
    let response: Response;
    try { response = await requestTimings.wait("web search headers", () => this.request(url, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept: 'application/json', ...(this.access ? { 'CF-Access-Client-Id': this.access.clientId, 'CF-Access-Client-Secret': this.access.clientSecret } : {}) } })); }
    catch (error) { throw new ToolError('Web search service is unavailable or timed out.', 'failed', { cause: error }); }
    if (!response.ok) { await response.body?.cancel(); throw new ToolError(response.status === 403 ? (this.access ? 'Search access denied. Check the Cloudflare Access service-token policy and credentials.' : 'Search returned HTTP 403. Enable JSON format in SearXNG settings.') : `Search returned HTTP ${response.status}`, 'failed'); }
    if (!response.body) throw new ToolError('Empty search response', 'failed');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const item = await requestTimings.wait("web search body", () => reader.read()); if (item.done) break; size += item.value.length; if (size > 1024 * 1024) throw new ToolError('Search response exceeds 1 MiB', 'failed'); chunks.push(item.value); } } finally { await reader.cancel(); }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) { throw new ToolError('Search did not return JSON. Check SearXNG settings.', 'failed', { cause: error }); }
    if (!payload || typeof payload !== 'object' || !('results' in payload) || !Array.isArray(payload.results)) throw new ToolError('Invalid search response', 'failed');
    const hits: SearchHit[] = []; const seen = new Set<string>();
    for (const raw of payload.results) {
      if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string') continue;
      let link: URL; try { link = new URL(raw.url); } catch { continue; }
      if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password || seen.has(link.href)) continue;
      seen.add(link.href);
      hits.push({ url: link.href, title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : link.hostname, snippet: typeof raw.content === 'string' ? raw.content.slice(0, 800) : '' });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}
