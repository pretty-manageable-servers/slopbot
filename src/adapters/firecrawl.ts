import { ToolError } from '../errors.js';
import { requestTimings } from '../request-timing.js';
import { FETCH_TEXT_LIMIT, ProviderFailed, type KeyedFetch, type KeyedSearch, type PageText, type ProviderKey, type WebProvider } from '../web-providers.js';
import type { SearchHit } from '../web-search.js';

const SEARCH_URL = 'https://api.firecrawl.dev/v2/search';
const SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';
const SEARCH_BODY_LIMIT = 1024 * 1024;
const SCRAPE_BODY_LIMIT = 4 * 1024 * 1024;
/** 'timeout' for an abort or timeout error, otherwise 'network'. */
function failureStatus(error: unknown): 'timeout' | 'network' {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
}

// Every request must cost exactly the base credits: no scrapeOptions, no extra formats, no stealth or auto proxy, no actions, no PDF parsing, no retries.
export class FirecrawlSearch implements KeyedSearch {
  constructor(private readonly request: typeof fetch = fetch) {}
  async search(key: ProviderKey, query: string, limit: number): Promise<readonly SearchHit[]> {
    if (!query.trim() || query.length > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new ToolError('Invalid search query or result limit');
    const payload = await postJson(this.request, 'firecrawl_search', SEARCH_URL, { query, limit, sources: ['web'] }, key, 30000, SEARCH_BODY_LIMIT);
    if (!payload || typeof payload !== 'object' || !('success' in payload) || payload.success !== true || !('data' in payload)) throw new ProviderFailed('firecrawl_search', 'Invalid Firecrawl search response', false, { status: 'bad_response' });
    const data = payload.data;
    const items = Array.isArray(data) ? data : data && typeof data === 'object' && 'web' in data ? data.web : undefined;
    if (!Array.isArray(items)) throw new ProviderFailed('firecrawl_search', 'Invalid Firecrawl search response', false, { status: 'bad_response' });
    const hits: SearchHit[] = []; const seen = new Set<string>();
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string') continue;
      let link: URL; try { link = new URL(raw.url); } catch { continue; }
      if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password || seen.has(link.href)) continue;
      seen.add(link.href);
      hits.push({ url: link.href, title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : link.hostname, snippet: typeof raw.description === 'string' ? raw.description.slice(0, 800) : '' });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}

// Every request must cost exactly the base credits: parsers [] keeps PDFs from billing per page, and proxy 'basic' is the cheapest tier.
export class FirecrawlScrape implements KeyedFetch {
  constructor(private readonly request: typeof fetch = fetch) {}
  async fetch(key: ProviderKey, url: string): Promise<PageText> {
    let link: URL; try { link = new URL(url); } catch { throw new ToolError('Invalid page URL'); }
    if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password) throw new ToolError('Page URL must be HTTP(S) without credentials');
    const body = { url: link.href, formats: ['markdown'], onlyMainContent: true, proxy: 'basic', parsers: [], blockAds: true, timeout: 30000 };
    const payload = await postJson(this.request, 'firecrawl_scrape', SCRAPE_URL, body, key, 45000, SCRAPE_BODY_LIMIT);
    const data = payload && typeof payload === 'object' && 'success' in payload && payload.success === true && 'data' in payload ? payload.data : undefined;
    if (!data || typeof data !== 'object') throw new ProviderFailed('firecrawl_scrape', 'Invalid Firecrawl scrape response', false, { status: 'bad_response' });
    const markdown = 'markdown' in data && typeof data.markdown === 'string' ? data.markdown : '';
    if (!markdown.trim()) throw new ProviderFailed('firecrawl_scrape', 'Firecrawl returned no page text', false, { status: 'empty' });
    const title = 'metadata' in data && data.metadata && typeof data.metadata === 'object' && 'title' in data.metadata && typeof data.metadata.title === 'string' ? data.metadata.title : link.hostname;
    return { url: link.href, title: title.slice(0, 200), text: markdown.slice(0, FETCH_TEXT_LIMIT), truncated: markdown.length > FETCH_TEXT_LIMIT };
  }
}

/** POSTs JSON with the team key. Maps every failure to ProviderFailed without the secret. Cancels bodies it does not read. */
async function postJson(request: typeof fetch, provider: WebProvider, url: string, body: object, key: ProviderKey, timeout: number, cap: number): Promise<unknown> {
  let response: Response;
  try { response = await requestTimings.wait(`${provider} headers`, () => request(url, { method: 'POST', signal: AbortSignal.timeout(timeout), redirect: 'error', headers: { Authorization: `Bearer ${key.secret}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })); }
  catch (error) { throw new ProviderFailed(provider, `Firecrawl ${provider === 'firecrawl_search' ? 'search' : 'scrape'} is unavailable or timed out.`, false, { cause: error, status: failureStatus(error) }); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const status = String(response.status);
    if (response.status === 402) throw new ProviderFailed(provider, 'Firecrawl credits are used up for this key.', true, { status });
    if (response.status === 401) throw new ProviderFailed(provider, 'Firecrawl key is invalid.', true, { status });
    throw new ProviderFailed(provider, `Firecrawl returned HTTP ${response.status}`, false, { status });
  }
  if (!response.body) throw new ProviderFailed(provider, 'Firecrawl sent an empty response', false, { status: 'empty' });
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await requestTimings.wait(`${provider} body`, () => reader.read());
      if (item.done) break;
      size += item.value.length;
      if (size > cap) throw new ProviderFailed(provider, `Firecrawl response exceeds ${cap / 1024 / 1024} MiB`, false, { status: 'too_large' });
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof ProviderFailed) throw error;
    throw new ProviderFailed(provider, 'Firecrawl response could not be read', false, { cause: error, status: failureStatus(error) });
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) { throw new ProviderFailed(provider, 'Firecrawl did not return JSON', false, { cause: error, status: 'bad_response' }); }
}
