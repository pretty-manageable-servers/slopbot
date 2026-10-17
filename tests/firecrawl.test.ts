import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FirecrawlScrape, FirecrawlSearch} from '../src/adapters/firecrawl.js';
import {ProviderFailed, type ProviderKey} from '../src/web-providers.js';

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
    {url: 'https://two.example/', title: 'Two', description: 'x'},
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
    {url: 'https://two.example/', title: 'Two', snippet: 'x'},
  ]);
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

test('Firecrawl scrape rejects unsafe URLs before any request', async () => {
  const {request, calls} = fakeFetch(() => Response.json({success: true, data: {markdown: 'x', metadata: {}}}));
  const scrape = new FirecrawlScrape(request);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@page.example/', 'https://u@page.example/', 'not a url']) {
    await assert.rejects(scrape.fetch(key, url), /Invalid page URL|Page URL must be HTTP/);
  }
  assert.equal(calls.length, 0);
});

test('Firecrawl scrape accepts a body up to 4 MiB and rejects more (body size limit)', async () => {
  const padding = 'x'.repeat(4 * 1024 * 1024 - 200);
  const big = JSON.stringify({success: true, data: {markdown: 'ok', metadata: {title: padding}}});
  assert.ok(Buffer.byteLength(big) <= 4 * 1024 * 1024);
  const ok = await new FirecrawlScrape(fakeFetch(() => new Response(big)).request).fetch(key, 'https://page.example/');
  assert.equal(ok.text, 'ok');
  const tooBig = fakeFetch(() => new Response('x'.repeat(4 * 1024 * 1024 + 1)));
  await assert.rejects(new FirecrawlScrape(tooBig.request).fetch(key, 'https://page.example/'), (error: unknown) => { assertFailed(error, 'firecrawl_scrape', false, /4 MiB/); return true; });
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

test('Firecrawl search sets the status of each failure', async () => {
  const cases: [string, () => Response | Promise<Response>][] = [
    ['402', () => new Response('{}', {status: 402})],
    ['401', () => new Response('{}', {status: 401})],
    ['500', () => new Response('{}', {status: 500})],
    ['empty', () => new Response(null)],
    ['too_large', () => new Response('x'.repeat(1024 * 1024 + 1))],
    ['bad_response', () => new Response('{not json')],
    ['bad_response', () => Response.json({success: false})],
  ];
  for (const [status, reply] of cases) {
    const {request} = fakeFetch(reply);
    await assert.rejects(new FirecrawlSearch(request).search(key, 'q', 1), (error: unknown) => error instanceof ProviderFailed && error.status === status && error.keyExhausted === (status === '402' || status === '401'), status);
  }
  const timeout = (async () => { throw Object.assign(new Error('timed out'), {name: 'TimeoutError'}); }) as typeof fetch;
  await assert.rejects(new FirecrawlSearch(timeout).search(key, 'q', 1), (error: unknown) => error instanceof ProviderFailed && error.status === 'timeout');
  const network = (async () => { throw new TypeError('socket hang up'); }) as typeof fetch;
  await assert.rejects(new FirecrawlSearch(network).search(key, 'q', 1), (error: unknown) => error instanceof ProviderFailed && error.status === 'network');
});

test('Firecrawl scrape sets the status of each failure', async () => {
  const cases: [string, () => Response | Promise<Response>][] = [
    ['402', () => new Response('{}', {status: 402})],
    ['401', () => new Response('{}', {status: 401})],
    ['500', () => new Response('{}', {status: 500})],
    ['empty', () => new Response(null)],
    ['too_large', () => new Response('x'.repeat(4 * 1024 * 1024 + 1))],
    ['bad_response', () => new Response('{not json')],
    ['bad_response', () => Response.json({success: true})],
    ['empty', () => Response.json({success: true, data: {markdown: '   ', metadata: {}}})],
  ];
  for (const [status, reply] of cases) {
    const {request} = fakeFetch(reply);
    await assert.rejects(new FirecrawlScrape(request).fetch(key, 'https://page.example/'), (error: unknown) => error instanceof ProviderFailed && error.status === status && error.keyExhausted === (status === '402' || status === '401'), status);
  }
});
