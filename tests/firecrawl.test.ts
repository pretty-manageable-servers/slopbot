import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FirecrawlScrape, FirecrawlSearch} from '../src/adapters/firecrawl.js';
import {FETCH_TEXT_LIMIT, ProviderFailed, type ProviderKey} from '../src/web-providers.js';

const key: ProviderKey = {id: 'k1', provider: 'firecrawl', secret: 'fc-secret-value'};

type Call = {url: URL; method: string | undefined; headers: Headers; body: Record<string, unknown>};

/** A fake fetch that records each request and answers with reply(). */
function fakeFetch(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({url: new URL(String(input)), method: init?.method, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body))});
    return reply();
  }) as typeof fetch;
  return {request, calls};
}

function assertFailed(error: unknown, provider: string, keyExhausted: boolean, message?: RegExp): void {
  assert.ok(error instanceof ProviderFailed, `expected ProviderFailed, got ${String(error)}`);
  assert.equal(error.provider, provider);
  assert.equal(error.keyExhausted, keyExhausted);
  if (message) assert.match(error.message, message);
  assert.ok(!error.message.includes(key.secret), 'secret must not appear in the error message');
}

test('Firecrawl search sends the exact base-cost body and maps the v2 shape', async () => {
  const {request, calls} = fakeFetch(() => Response.json({success: true, data: {web: [
    {url: 'https://one.example/', title: 'One', description: 'snippet'},
    {url: 'https://one.example/', title: 'duplicate', description: 'dup'},
    {url: 'javascript:alert(1)', title: 'bad', description: 'bad'},
    {url: 'https://user:pw@two.example/', title: 'creds', description: 'bad'},
    {url: 'https://two.example/', title: 'Two', description: 'x'.repeat(1000)},
    {url: 'https://three.example/', title: 'Three', description: 'y'},
  ]}}));
  const results = await new FirecrawlSearch(request).search(key, 'current news', 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url.href, 'https://api.firecrawl.dev/v2/search');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.headers.get('Authorization'), `Bearer ${key.secret}`);
  assert.deepEqual(calls[0]?.body, {query: 'current news', limit: 2, sources: ['web']});
  assert.equal('scrapeOptions' in (calls[0]?.body ?? {}), false);
  assert.deepEqual(results, [
    {url: 'https://one.example/', title: 'One', snippet: 'snippet'},
    {url: 'https://two.example/', title: 'Two', snippet: 'x'.repeat(800)},
  ]);
});

test('Firecrawl search accepts the v1 array shape and caps titles at 200 characters', async () => {
  const {request} = fakeFetch(() => Response.json({success: true, data: [
    {url: 'https://one.example/', title: 't'.repeat(300), description: 'snippet'},
    {url: 'https://two.example/', description: 'no title'},
  ]}));
  const results = await new FirecrawlSearch(request).search(key, 'query', 5);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.title.length, 200);
  assert.equal(results[1]?.title, 'two.example');
});

test('Firecrawl search returns an empty array when nothing matches', async () => {
  const {request} = fakeFetch(() => Response.json({success: true, data: {web: []}}));
  assert.deepEqual(await new FirecrawlSearch(request).search(key, 'nothing', 3), []);
});

test('Firecrawl search rejects bad input before any request', async () => {
  const {request, calls} = fakeFetch(() => Response.json({success: true, data: {web: []}}));
  const search = new FirecrawlSearch(request);
  await assert.rejects(search.search(key, '   ', 1), /Invalid search query/);
  await assert.rejects(search.search(key, 'q'.repeat(1001), 1), /Invalid search query/);
  await assert.rejects(search.search(key, 'q', 0), /Invalid search query/);
  await assert.rejects(search.search(key, 'q', 11), /Invalid search query/);
  await assert.rejects(search.search(key, 'q', 1.5), /Invalid search query/);
  assert.equal(calls.length, 0);
});

test('Firecrawl scrape sends the exact base-cost body and returns page text', async () => {
  const {request, calls} = fakeFetch(() => Response.json({success: true, data: {markdown: '# Hello', metadata: {title: 'Hello page', sourceURL: 'https://page.example/a'}}}));
  const page = await new FirecrawlScrape(request).fetch(key, 'https://page.example/a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url.href, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.headers.get('Authorization'), `Bearer ${key.secret}`);
  assert.deepEqual(calls[0]?.body, {url: 'https://page.example/a', formats: ['markdown'], onlyMainContent: true, proxy: 'basic', parsers: [], blockAds: true, timeout: 30000});
  assert.deepEqual(page, {url: 'https://page.example/a', title: 'Hello page', text: '# Hello', truncated: false});
});

test('Firecrawl scrape cuts text at the fetch limit and sets the truncated flag', async () => {
  const markdown = 'a'.repeat(FETCH_TEXT_LIMIT + 500);
  const {request} = fakeFetch(() => Response.json({success: true, data: {markdown, metadata: {title: 't'.repeat(300)}}}));
  const page = await new FirecrawlScrape(request).fetch(key, 'https://page.example/');
  assert.equal(page.text.length, FETCH_TEXT_LIMIT);
  assert.equal(page.truncated, true);
  assert.equal(page.title.length, 200);
});

test('Firecrawl scrape rejects empty markdown and unsafe URLs before any request', async () => {
  const empty = fakeFetch(() => Response.json({success: true, data: {markdown: '   ', metadata: {}}}));
  await assert.rejects(new FirecrawlScrape(empty.request).fetch(key, 'https://page.example/'), (error: unknown) => { assertFailed(error, 'firecrawl_scrape', false, /no page text/); return true; });
  const {request, calls} = fakeFetch(() => Response.json({success: true, data: {markdown: 'x', metadata: {}}}));
  const scrape = new FirecrawlScrape(request);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@page.example/', 'https://u@page.example/', 'not a url']) {
    await assert.rejects(scrape.fetch(key, url), /Invalid page URL|Page URL must be HTTP/);
  }
  assert.equal(calls.length, 0);
});

test('Firecrawl scrape accepts a body up to 4 MiB and rejects more', async () => {
  const padding = 'x'.repeat(4 * 1024 * 1024 - 200);
  const big = JSON.stringify({success: true, data: {markdown: 'ok', metadata: {title: padding}}});
  assert.ok(Buffer.byteLength(big) <= 4 * 1024 * 1024);
  const ok = await new FirecrawlScrape(fakeFetch(() => new Response(big)).request).fetch(key, 'https://page.example/');
  assert.equal(ok.text, 'ok');
  const tooBig = fakeFetch(() => new Response('x'.repeat(4 * 1024 * 1024 + 1)));
  await assert.rejects(new FirecrawlScrape(tooBig.request).fetch(key, 'https://page.example/'), (error: unknown) => { assertFailed(error, 'firecrawl_scrape', false, /4 MiB/); return true; });
});

test('Firecrawl search rejects a body over 1 MiB', async () => {
  const {request} = fakeFetch(() => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(new FirecrawlSearch(request).search(key, 'q', 1), (error: unknown) => { assertFailed(error, 'firecrawl_search', false, /1 MiB/); return true; });
});

test('Firecrawl treats HTTP 402 and 401 as an exhausted key', async () => {
  const exhausted = fakeFetch(() => new Response('{}', {status: 402}));
  await assert.rejects(new FirecrawlSearch(exhausted.request).search(key, 'q', 1), (error: unknown) => { assertFailed(error, 'firecrawl_search', true, /credits are used up/); return true; });
  await assert.rejects(new FirecrawlScrape(exhausted.request).fetch(key, 'https://page.example/'), (error: unknown) => { assertFailed(error, 'firecrawl_scrape', true, /credits are used up/); return true; });
  const invalid = fakeFetch(() => new Response('{}', {status: 401}));
  await assert.rejects(new FirecrawlSearch(invalid.request).search(key, 'q', 1), (error: unknown) => { assertFailed(error, 'firecrawl_search', true, /key is invalid/); return true; });
  await assert.rejects(new FirecrawlScrape(invalid.request).fetch(key, 'https://page.example/'), (error: unknown) => { assertFailed(error, 'firecrawl_scrape', true, /key is invalid/); return true; });
});

test('Firecrawl treats HTTP 500 and 429 as a plain failure, not an exhausted key', async () => {
  for (const status of [500, 429]) {
    const {request} = fakeFetch(() => new Response('{}', {status}));
    await assert.rejects(new FirecrawlSearch(request).search(key, 'q', 1), (error: unknown) => { assertFailed(error, 'firecrawl_search', false, new RegExp(`HTTP ${status}`)); return true; });
    await assert.rejects(new FirecrawlScrape(request).fetch(key, 'https://page.example/'), (error: unknown) => { assertFailed(error, 'firecrawl_scrape', false); return true; });
  }
});

test('Firecrawl cancels an unread error body', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new TextEncoder().encode('error')); }, cancel() { cancelled = true; } });
  const {request} = fakeFetch(() => new Response(body, {status: 500}));
  await assert.rejects(new FirecrawlSearch(request).search(key, 'q', 1), ProviderFailed);
  assert.equal(cancelled, true);
});

test('Firecrawl reports a network error or timeout as a plain failure', async () => {
  const failing = (async () => { throw new TypeError('socket hang up'); }) as typeof fetch;
  await assert.rejects(new FirecrawlSearch(failing).search(key, 'q', 1), (error: unknown) => { assertFailed(error, 'firecrawl_search', false, /unavailable or timed out/); return true; });
  await assert.rejects(new FirecrawlScrape(failing).fetch(key, 'https://page.example/'), (error: unknown) => { assertFailed(error, 'firecrawl_scrape', false, /unavailable or timed out/); return true; });
});

test('Firecrawl reports success:false, bad JSON and a bad shape as plain failures', async () => {
  const cases: [string, () => Response][] = [
    ['success false', () => Response.json({success: false, error: 'nope'})],
    ['bad JSON', () => new Response('{not json')],
    ['missing data', () => Response.json({success: true})],
  ];
  for (const [name, reply] of cases) {
    const {request} = fakeFetch(reply);
    await assert.rejects(new FirecrawlSearch(request).search(key, 'q', 1), (error: unknown) => { assertFailed(error, 'firecrawl_search', false); return true; }, name);
    await assert.rejects(new FirecrawlScrape(request).fetch(key, 'https://page.example/'), (error: unknown) => { assertFailed(error, 'firecrawl_scrape', false); return true; }, name);
  }
});

test('Firecrawl never puts the secret in an error message', async () => {
  const replies: (() => Response | Promise<Response>)[] = [
    () => new Response('{}', {status: 402}),
    () => new Response('{}', {status: 401}),
    () => new Response('{}', {status: 500}),
    () => Response.json({success: false, error: `bad key ${key.secret}`}),
    () => new Response('{"markdown":"x"'),
  ];
  for (const reply of replies) {
    const {request} = fakeFetch(reply);
    await assert.rejects(new FirecrawlSearch(request).search(key, 'q', 1), (error: unknown) => { assertFailed(error, 'firecrawl_search', error instanceof ProviderFailed && error.keyExhausted); return true; });
    await assert.rejects(new FirecrawlScrape(request).fetch(key, 'https://page.example/'), (error: unknown) => { assertFailed(error, 'firecrawl_scrape', error instanceof ProviderFailed && error.keyExhausted); return true; });
  }
  const leaking = fakeFetch(() => { throw new Error(`socket with ${key.secret}`); });
  await assert.rejects(new FirecrawlSearch(leaking.request).search(key, 'q', 1), (error: unknown) => { assertFailed(error, 'firecrawl_search', false); return true; });
});
