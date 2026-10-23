import { BlockList, isIP } from 'node:net';
import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import { ToolError } from '../tools.js';
import { FETCH_TEXT_LIMIT, ProviderFailed, type PageText, type WebFetch } from '../web-providers.js';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MIN_TEXT = 20;
const SHELL_TEXT = 300;
const BOT_TEXT = 1500;
const SCRIPT_SHARE = 0.8;
const MAX_TITLE = 200;
const MAX_FETCHES_PER_MINUTE = 30;
const USER_AGENT = 'Slopbot/1.0 (+https://github.com/pretty-manageable-servers/slopbot)';
const TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const PORTS = new Set(['', '80', '443']);

/** Address ranges that a server-side fetch must never reach: private, loopback, link-local, metadata, CGNAT, multicast, reserved. */
const BLOCKED_IPV4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
/** IPv4-mapped, IPv4-compatible and NAT64 forms are blocked as a whole, so their embedded IPv4 cannot slip through. */
const BLOCKED_IPV6: [string, number][] = [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];
// One list per family. In a mixed list, Node matches IPv4 addresses against the IPv6 rules too.
const blockedIPv4 = new BlockList();
for (const [address, prefix] of BLOCKED_IPV4) blockedIPv4.addSubnet(address, prefix, 'ipv4');
const blockedIPv6 = new BlockList();
for (const [address, prefix] of BLOCKED_IPV6) blockedIPv6.addSubnet(address, prefix, 'ipv6');

const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
  'Accept-Encoding': 'identity',
};

export interface LookupAddress { address: string; family: number }
/** One request, sent to the address that was checked. The Host header and TLS name stay the original host. */
export interface PinnedRequest { address: string; family: number; headers: Record<string, string>; signal: AbortSignal }
export interface FetchedResponse {
  status: number;
  /** Header names are lower case. */
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}
export type PlainRequest = (url: URL, pinned: PinnedRequest) => Promise<FetchedResponse>;
export interface PlainFetchOptions {
  request?: PlainRequest;
  lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
  now?: () => number;
}

/** Free web_fetch step. Reads one public http(s) page and returns its main content as Markdown. */
export class PlainFetch implements WebFetch {
  private readonly request: PlainRequest;
  private readonly lookup: (hostname: string) => Promise<readonly LookupAddress[]>;
  private readonly now: () => number;
  private fetches: number[] = [];

  constructor(options: PlainFetchOptions = {}) {
    this.request = options.request ?? httpRequest;
    this.lookup = options.lookup ?? (hostname => dns.lookup(hostname, { all: true }));
    this.now = options.now ?? Date.now;
  }

  async fetch(url: string): Promise<PageText> {
    const now = this.now(); this.fetches = this.fetches.filter(time => time > now - 60_000);
    if (this.fetches.length >= MAX_FETCHES_PER_MINUTE) throw new ToolError('Page fetch limit reached. Retry in a minute.', 'failed');
    this.fetches.push(now);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await this.run(url, controller.signal);
    } catch (error) {
      if (error instanceof ProviderFailed || error instanceof ToolError) throw error;
      throw failure(controller.signal.aborted ? 'Page fetch timed out.' : 'Page could not be fetched.', error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(input: string, signal: AbortSignal): Promise<PageText> {
    let url = parseUrl(input);
    for (let redirects = 0; ; redirects++) {
      const target = await this.checkTarget(url, signal);
      const response = await this.request(url, { address: target.address, family: target.family, headers: { ...REQUEST_HEADERS }, signal });
      if (!REDIRECT_CODES.has(response.status)) return await this.readPage(url, response);
      response.destroy();
      const location = header(response.headers, 'location');
      if (!location) throw failure(`Redirect HTTP ${response.status} has no Location header.`);
      if (redirects >= MAX_REDIRECTS) throw failure(`Page has more than ${MAX_REDIRECTS} redirects.`);
      url = parseUrl(location, url);
    }
  }

  /** Checks scheme, credentials, port and every resolved address. Returns the one address to connect to. */
  private async checkTarget(url: URL, signal: AbortSignal): Promise<{ address: string; family: number }> {
    if (!['http:', 'https:'].includes(url.protocol)) throw refusal('Only http and https pages can be fetched.');
    if (url.username || url.password) throw refusal('URLs with a user name or password are refused.');
    if (!PORTS.has(url.port)) throw refusal('Only ports 80 and 443 can be fetched.');
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase().replace(/\.$/, '');
    if (isIP(host)) {
      if (blockedAddress(host)) throw refusal('Address is not allowed.');
      return { address: host, family: isIP(host) };
    }
    if (blockedName(host)) throw refusal('Host name is not allowed.');
    const addresses = await Promise.race([this.lookup(host), aborted(signal)]);
    if (!addresses.length) throw failure('Host name has no address.');
    // Any private address refuses the whole host, so a mixed DNS answer cannot be used to reach internal services.
    if (addresses.some(entry => blockedAddress(entry.address))) throw refusal('Host name resolves to a blocked address.');
    const first = addresses[0];
    if (!first) throw failure('Host name has no address.');
    return { address: first.address, family: isIP(first.address) };
  }

  private async readPage(url: URL, response: FetchedResponse): Promise<PageText> {
    if (response.status < 200 || response.status > 299) {
      response.destroy();
      // A 4xx is the site's own answer. A 5xx may be an outage, so it is not.
      throw failure(`Page returned HTTP ${response.status}.`, undefined, response.status >= 400 && response.status < 500 ? { httpStatus: response.status } : undefined);
    }
    const contentType = header(response.headers, 'content-type') ?? '';
    const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!TYPES.includes(type)) { response.destroy(); throw failure(`Page type ${type || 'unknown'} is not supported.`, undefined, {}); }
    const encoding = header(response.headers, 'content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') { response.destroy(); throw failure('Compressed pages are not supported.'); }
    const declared = header(response.headers, 'content-length');
    if (declared && Number(declared) > MAX_BYTES) { response.destroy(); throw failure('Page is larger than 2 MiB.'); }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw failure('Page is larger than 2 MiB.');
      chunks.push(chunk);
    }
    const raw = decode(Buffer.concat(chunks), /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1]);
    const page = type === 'text/plain' ? { title: url.hostname, content: raw } : await extract(raw, url);
    const body = page.content.trim();
    // Plain text has no markup to inspect, so only the length rule applies to it.
    const reason = type === 'text/plain' ? (collapse(body).length < MIN_TEXT ? NO_TEXT : undefined) : uselessPage(raw, body);
    if (reason) throw failure(reason, undefined, {});
    const truncated = body.length > FETCH_TEXT_LIMIT;
    return {
      url: url.href,
      title: page.title.trim().slice(0, MAX_TITLE) || url.hostname,
      text: truncated ? cutText(body) : body,
      truncated,
    };
  }
}

const NO_TEXT = 'Page has no text.';
const NEEDS_JS = 'Page needs JavaScript.';
const BOT_CHECK = 'Page is a bot check.';
/** An empty element with a common app mount id, such as <div id="root"></div>. */
const MOUNT = /<([a-z][\w-]*)\b[^>]*\sid=["'](?:root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/\1\s*>/i;
const NO_JS = /enable javascript|javascript is required/i;
const BOT_WALL = /checking your browser|verify you are human|enable javascript and cookies|cf-chl|just a moment\.\.\.|access denied|captcha|are you a robot|unusual traffic/i;

/**
 * Why a fetched page is useless, so that a paid scrape may be used. Returns undefined when the page is useful.
 * Short pages with real text are useful. Checks run in order, so the message is the most specific one that applies.
 */
export function uselessPage(html: string, text: string): string | undefined {
  const plain = collapse(text);
  if (plain.length < BOT_TEXT && BOT_WALL.test(`${plain}\n${html}`)) return BOT_CHECK;
  if (plain.length < SHELL_TEXT && isShell(html)) return NEEDS_JS;
  if (plain.length < MIN_TEXT) return NO_TEXT;
  return undefined;
}

function isShell(html: string): boolean {
  if (MOUNT.test(html)) return true;
  if (blocks(html, 'noscript').some(block => NO_JS.test(block))) return true;
  const scriptChars = blocks(html, 'script').reduce((sum, block) => sum + block.length, 0);
  return html.length > 0 && scriptChars > html.length * SCRIPT_SHARE;
}

/** The text of each <tag>...</tag> block. An unclosed block runs to the end. Linear in the HTML length. */
function blocks(html: string, tag: string): string[] {
  const open = new RegExp(`<${tag}\\b`, 'gi');
  const close = new RegExp(`</${tag}`, 'gi');
  const found: string[] = [];
  let start = open.exec(html);
  while (start) {
    close.lastIndex = start.index;
    const end = close.exec(html);
    found.push(html.slice(start.index, end ? end.index : html.length));
    if (!end) break;
    open.lastIndex = end.index;
    start = open.exec(html);
  }
  return found;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function httpRequest(url: URL, pinned: PinnedRequest): Promise<FetchedResponse> {
  const library = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = library.request(url, {
      method: 'GET',
      headers: pinned.headers,
      signal: pinned.signal,
      agent: false,
      // Connect only to the checked address. The Host header and TLS server name still come from the URL.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      },
    }, response => resolve({
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: response,
      destroy: () => response.destroy(),
    }));
    request.on('error', reject);
    request.end();
  });
}

function parseUrl(input: string, base?: URL): URL {
  try { return new URL(input, base); } catch (error) { throw failure('URL is not valid.', error); }
}

/** Names that mean this machine or the private network. A name with no dot is an internal service name. */
function blockedName(host: string): boolean {
  return !host.includes('.') || /(^|\.)(localhost|local|internal|svc)$/.test(host);
}

function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIPv4.check(address, 'ipv4');
  if (family === 6) return blockedIPv6.check(address, 'ipv6');
  return true;
}

async function extract(html: string, url: URL): Promise<{ title: string; content: string }> {
  const { document } = parseHTML(html);
  // useAsync false stops Defuddle from calling third-party APIs (YouTube, X, Reddit) with the server's network.
  const result = await Defuddle(document as unknown as Document, url.href, { markdown: true, useAsync: false });
  return { title: result.title, content: result.content };
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
  try { return new TextDecoder(charset ?? 'utf-8').decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

/** Cuts text at the limit without splitting a surrogate pair. */
function cutText(text: string): string {
  const head = text.slice(0, FETCH_TEXT_LIMIT);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

function header(headers: FetchedResponse['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Rejects when the signal aborts, so a slow DNS lookup still stops at the 10 second limit. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(failure('Page fetch timed out.'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/** A URL that must never be fetched by anyone. Not a provider failure, so the chain does not fall back to a paid service. */
function refusal(message: string): ToolError {
  return new ToolError(message, 'rejected');
}

/** A failed page read. siteAnswer is set when the site answered for certain: a 4xx status, or a page that cannot be read. */
function failure(message: string, cause?: unknown, siteAnswer?: { httpStatus?: number }): ProviderFailed {
  return new ProviderFailed('plain_fetch', message, false, { ...(cause === undefined ? {} : { cause }), ...(siteAnswer ? { siteAnswer } : {}) });
}
