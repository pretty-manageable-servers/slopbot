import { ToolError } from '../tools.js';
import { requestTimings } from "../request-timing.js";
import { ProviderFailed, type KeyedSearch, type ProviderKey } from '../web-providers.js';
import type { SearchHit } from '../web-search.js';
const ENDPOINT = 'https://api.tavily.com/search';
/** 'timeout' for an abort or timeout error, otherwise 'network'. */
function failureStatus(error: unknown): 'timeout' | 'network' {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
}
export class TavilySearch implements KeyedSearch {
  constructor(private readonly request: typeof fetch = fetch) {}
  async search(key: ProviderKey, query: string, limit: number): Promise<readonly SearchHit[]> {
    if (!query.trim() || query.length > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new ToolError('Invalid search query or result limit');
    let response: Response;
    try { response = await requestTimings.wait("tavily search headers", () => this.request(ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Authorization: `Bearer ${key.secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', include_answer: false, include_raw_content: false, include_images: false }) })); }
    catch (error) { throw new ProviderFailed('tavily', 'Tavily search is unavailable or timed out.', false, { cause: error, status: failureStatus(error) }); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const status = String(response.status);
      if (response.status === 432 || response.status === 433) throw new ProviderFailed('tavily', `Tavily key is out of credits or over its plan limit (HTTP ${response.status}).`, true, { status });
      if (response.status === 401) throw new ProviderFailed('tavily', 'Tavily rejected the team key as invalid (HTTP 401). Check the key in the admin panel.', true, { status });
      throw new ProviderFailed('tavily', `Tavily search returned HTTP ${response.status}`, false, { status });
    }
    if (!response.body) throw new ProviderFailed('tavily', 'Empty Tavily search response', false, { status: 'empty' });
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const item = await requestTimings.wait("tavily search body", () => reader.read());
        if (item.done) break;
        size += item.value.length;
        if (size > 1024 * 1024) throw new ProviderFailed('tavily', 'Tavily search response exceeds 1 MiB', false, { status: 'too_large' });
        chunks.push(item.value);
      }
    } catch (error) {
      if (error instanceof ProviderFailed) throw error;
      throw new ProviderFailed('tavily', 'Tavily search response could not be read', false, { cause: error, status: failureStatus(error) });
    } finally { await reader.cancel().catch(() => undefined); }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) { throw new ProviderFailed('tavily', 'Tavily search did not return JSON', false, { cause: error, status: 'bad_response' }); }
    if (!payload || typeof payload !== 'object' || !('results' in payload) || !Array.isArray(payload.results)) throw new ProviderFailed('tavily', 'Invalid Tavily search response', false, { status: 'bad_response' });
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
