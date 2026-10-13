import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PlainFetch, type FetchedResponse, type LookupAddress, type PinnedRequest} from '../src/adapters/plain-fetch.js';
import {ToolError} from '../src/tools.js';
import {FETCH_TEXT_LIMIT, ProviderFailed} from '../src/web-providers.js';

const PUBLIC: LookupAddress[] = [{address: '93.184.216.34', family: 4}];
const SENTENCE = 'Sea turtles travel thousands of kilometres between feeding grounds and the beaches where they hatched, and researchers track their routes with small satellite tags.';
const ARTICLE = `<!doctype html><html><head><title>Turtle routes</title></head><body>
<nav><a href="/">Home</a> | <a href="/pricing">Pricing</a> | <a href="/login">Log in</a></nav>
<article><h1>Turtle routes</h1>${Array.from({length: 6}, () => `<p>${SENTENCE}</p>`).join('')}</article>
<footer>Copyright footer links and cookie settings</footer></body></html>`;

function page(body: string | Buffer, init: {status?: number; type?: string; headers?: Record<string, string>} = {}): FetchedResponse {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  return {
    status: init.status ?? 200,
    headers: {'content-type': init.type ?? 'text/html; charset=utf-8', ...init.headers},
    body: (async function* () { yield bytes; })(),
    destroy() {},
  };
}
function redirect(location: string, status = 302): FetchedResponse {
  return page('', {status, type: 'text/plain', headers: {location}});
}
/** Answers each request in order and records the address and URL it was sent to. */
function scripted(...responses: FetchedResponse[]) {
  const calls: {url: string; address: string; headers: Record<string, string>}[] = [];
  const request = async (url: URL, pinned: PinnedRequest): Promise<FetchedResponse> => {
    calls.push({url: url.href, address: pinned.address, headers: pinned.headers});
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url.href}`);
    return next;
  };
  return {request, calls};
}
const resolver = (table: Record<string, LookupAddress[]>) => async (host: string) => table[host] ?? PUBLIC;
/** Retryable failure: the chain may try the next step. */
const isProviderFailed = (error: unknown) => error instanceof ProviderFailed && error.provider === 'plain_fetch';
/** Hard refusal: the URL must never be fetched by anyone. The chain must not fall back. */
const isRefusal = (error: unknown) => error instanceof ToolError && !(error instanceof ProviderFailed);
const messageMatches = (pattern: RegExp) => (error: unknown) => error instanceof Error && pattern.test(error.message);

test('blocked hosts and addresses are refused as ToolError before any request is sent', async () => {
  const urls = [
    'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.10/', 'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/', 'http://0.0.0.0/', 'http://224.0.0.1/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/',
    'http://[::ffff:10.0.0.1]/', 'http://localhost/', 'http://LOCALHOST./', 'http://printer.local/', 'http://db.svc/',
    'http://api.internal/', 'http://db.default.svc.cluster.local/', 'http://redis/',
  ];
  for (const url of urls) {
    const {request, calls} = scripted(page(ARTICLE));
    await assert.rejects(new PlainFetch({request, lookup: resolver({})}).fetch(url), isRefusal, url);
    assert.equal(calls.length, 0, url);
  }
});

test('a public name that resolves to a private address is refused as ToolError, even when another address is public', async () => {
  const lookup = resolver({
    'internal-looking.example': [{address: '10.1.2.3', family: 4}],
    'mixed.example': [{address: '93.184.216.34', family: 4}, {address: '192.168.0.9', family: 4}],
  });
  for (const url of ['https://internal-looking.example/', 'https://mixed.example/']) {
    const {request, calls} = scripted(page(ARTICLE));
    await assert.rejects(new PlainFetch({request, lookup}).fetch(url), isRefusal, url);
    assert.equal(calls.length, 0, url);
  }
});

test('the request goes to the checked address and keeps the host name and user agent', async () => {
  const {request, calls} = scripted(page(ARTICLE));
  const result = await new PlainFetch({request, lookup: resolver({})}).fetch('https://example.test/turtles');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.address, '93.184.216.34');
  assert.equal(calls[0]?.url, 'https://example.test/turtles');
  assert.equal(calls[0]?.headers['User-Agent'], 'Slopbot/1.0 (+https://github.com/pretty-manageable-servers/slopbot)');
  assert.equal(result.url, 'https://example.test/turtles');
});

test('a redirect to a private host is refused as ToolError', async () => {
  const {request, calls} = scripted(redirect('http://10.0.0.5/admin'), page(ARTICLE));
  await assert.rejects(new PlainFetch({request, lookup: resolver({})}).fetch('https://example.test/'), isRefusal);
  assert.equal(calls.length, 1);
});

test('a redirect to a public page is followed', async () => {
  const {request, calls} = scripted(redirect('/moved'), page(ARTICLE));
  const result = await new PlainFetch({request, lookup: resolver({})}).fetch('https://example.test/old');
  assert.equal(calls[1]?.url, 'https://example.test/moved');
  assert.equal(result.url, 'https://example.test/moved');
});

test('redirects stop after 3 hops as ProviderFailed', async () => {
  const three = scripted(redirect('/a'), redirect('/b'), redirect('/c'), page(ARTICLE));
  assert.equal((await new PlainFetch({request: three.request, lookup: resolver({})}).fetch('https://example.test/')).url, 'https://example.test/c');
  const four = scripted(redirect('/a'), redirect('/b'), redirect('/c'), redirect('/d'), page(ARTICLE));
  await assert.rejects(new PlainFetch({request: four.request, lookup: resolver({})}).fetch('https://example.test/'), isProviderFailed);
  assert.equal(four.calls.length, 4);
});

test('a redirect without a Location header is ProviderFailed', async () => {
  const {request} = scripted(page('', {status: 302, type: 'text/plain'}));
  await assert.rejects(new PlainFetch({request, lookup: resolver({})}).fetch('https://example.test/'), isProviderFailed);
});

test('only text pages are read; other types are ProviderFailed', async () => {
  for (const type of ['application/pdf', 'image/png', 'application/octet-stream']) {
    const {request} = scripted(page(ARTICLE, {type}));
    await assert.rejects(new PlainFetch({request, lookup: resolver({})}).fetch('https://example.test/'), isProviderFailed, type);
  }
});

test('pages over 2 MiB are ProviderFailed', async () => {
  const {request} = scripted(page(Buffer.alloc(2 * 1024 * 1024 + 1, 'a'), {type: 'text/plain'}));
  await assert.rejects(new PlainFetch({request, lookup: resolver({})}).fetch('https://example.test/'), error => isProviderFailed(error) && messageMatches(/2 MiB/)(error));
});

test('non-2xx pages and pages with almost no text are ProviderFailed so the chain moves on', async () => {
  const notFound = scripted(page(ARTICLE, {status: 404}));
  await assert.rejects(new PlainFetch({request: notFound.request, lookup: resolver({})}).fetch('https://example.test/'), isProviderFailed);
  const shell = scripted(page('<html><head><title>App</title></head><body><div id="root"></div><script>app()</script></body></html>'));
  await assert.rejects(new PlainFetch({request: shell.request, lookup: resolver({})}).fetch('https://example.test/'), isProviderFailed);
});

test('a network error and a DNS lookup error are ProviderFailed', async () => {
  const broken = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(new PlainFetch({request: broken, lookup: resolver({})}).fetch('https://example.test/'), isProviderFailed);
  const noDns = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(new PlainFetch({request: async () => page(ARTICLE), lookup: noDns}).fetch('https://example.test/'), isProviderFailed);
});

test('an HTML article becomes Markdown without navigation or footer text', async () => {
  const {request} = scripted(page(ARTICLE));
  const result = await new PlainFetch({request, lookup: resolver({})}).fetch('https://example.test/turtles');
  assert.equal(result.title, 'Turtle routes');
  assert.match(result.text, /Sea turtles travel/);
  assert.doesNotMatch(result.text, /Pricing/);
  assert.doesNotMatch(result.text, /cookie settings/);
  assert.equal(result.truncated, false);
});

test('plain text is returned as it is', async () => {
  const body = 'Plain notes about turtles. '.repeat(12);
  const {request} = scripted(page(body, {type: 'text/plain; charset=utf-8'}));
  const result = await new PlainFetch({request, lookup: resolver({})}).fetch('https://example.test/notes.txt');
  assert.equal(result.text, body.trim());
  assert.equal(result.truncated, false);
});

test('long pages are cut to the text limit and flagged as truncated', async () => {
  const paragraphs = Array.from({length: 60}, (_, index) => `<p>Paragraph ${index}. ${SENTENCE}</p>`).join('');
  const {request} = scripted(page(`<html><head><title>Long</title></head><body><article>${paragraphs}</article></body></html>`));
  const result = await new PlainFetch({request, lookup: resolver({})}).fetch('https://example.test/long');
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, FETCH_TEXT_LIMIT);
});

test('ports, credentials and non-http schemes are refused as ToolError before any request', async () => {
  for (const url of ['https://example.test:8443/', 'http://example.test:8080/', 'https://user:pass@example.test/', 'ftp://example.test/', 'file:///etc/passwd']) {
    const {request, calls} = scripted(page(ARTICLE));
    await assert.rejects(new PlainFetch({request, lookup: resolver({})}).fetch(url), isRefusal, url);
    assert.equal(calls.length, 0, url);
  }
});

test('a string that is not a URL is ProviderFailed', async () => {
  const {request, calls} = scripted(page(ARTICLE));
  await assert.rejects(new PlainFetch({request, lookup: resolver({})}).fetch('not a url'), isProviderFailed);
  assert.equal(calls.length, 0);
});

test('a page fetch is capped at 30 a minute as ToolError', async () => {
  let clock = 0;
  const request = async () => page(ARTICLE);
  const fetcher = new PlainFetch({request, lookup: resolver({}), now: () => clock});
  for (let i = 0; i < 30; i++) await fetcher.fetch('https://example.test/');
  await assert.rejects(fetcher.fetch('https://example.test/'), error => error instanceof ToolError && messageMatches(/limit reached/)(error));
  clock = 60_001;
  await fetcher.fetch('https://example.test/');
});

test('a page that never answers is cut off after 10 seconds as ProviderFailed', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const request = (_url: URL, pinned: PinnedRequest) => new Promise<FetchedResponse>((_, reject) => {
    pinned.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const pending = new PlainFetch({request, lookup: resolver({})}).fetch('https://example.test/');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  await assert.rejects(pending, error => isProviderFailed(error) && messageMatches(/timed out/)(error));
});
