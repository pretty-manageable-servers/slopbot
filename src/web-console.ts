import { describeError, errorSummary, logError } from "./errors.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { ToolError, type ToolArgs } from './tools.js';
import type { ChannelAccess } from './channel-access.js';
import { AdminInputError, serverPage, snowflake, type AdminPanel, type ServerInfo, type ServerPage } from './admin-panel.js';
import type { TeamRole } from './team-admins.js';
import type { TranscriptRoutes } from './web-transcripts.js';
import { WebReplyError } from './web-replies.js';
import { ShareError, isShareWrite, type ShareService } from './shares.js';
import type { WebSessionStore } from './web-session-store.js';
import type { ChatRoutes } from './web-chats.js';
import { ChatError } from './web-chats.js';
import { runtimeVersion } from './operations-config.js';
import type { InboxItem } from './inbox.js';

/** Team admin backend. Roles come from the Developer Portal team; panel holds the limits, prices and usage. */
export interface ConsoleAdmin {
  role(user: string): Promise<TeamRole | undefined>;
  canEdit(user: string): Promise<boolean>;
  /** One page of the servers Slopbot runs in, filtered by name. */
  servers(page: ServerPage): Promise<unknown>;
  /** One server's channels with their web transcript switches. */
  serverChannels(server: string): Promise<unknown>;
  /** The server's display name and icon. The name is the ID, and the icon null, when Discord has not cached the server. */
  serverInfo(server: string): ServerInfo;
  setTranscript(server: string, channel: string, enabled: boolean): Promise<unknown>;
  rotateWebhook(server: string, channel: string): Promise<unknown>;
  panel: AdminPanel;
}
export interface ConsoleBackend {
  /** Share links. Public page and snapshot routes, plus the admin list and writes. */
  shares?: ShareService;
  /** Copies a live share into a new private chat of the signed-in user. Errors with a ChatError keep their status. */
  continueShare?(user: string, shareId: string): Promise<unknown>;
  snapshot(user: string, server?: string): Promise<unknown>;
  /** True when the user shares at least one server with Slopbot. Throws when Discord cannot answer, so callers fail closed. */
  canSignIn(user: string): Promise<boolean>;
  /** The servers the user and Slopbot share, with the user's admin flag. Cached. Light: no channel or settings data. */
  servers?(user: string): Promise<{ id: string; name: string; icon: string | null; admin: boolean }[]>;
  invoke(user: string, server: string | undefined, channel: string, name: string, args: ToolArgs): Promise<unknown>;
  mcp?(user: string, server: string | undefined, input: unknown): Promise<unknown>;
  transcripts?(user: string, server: string): Promise<unknown>;
  /** The signed-in user's own usage meter for one server. Members only. */
  usage?(user: string, server: string): Promise<unknown>;
  /** Uses one of the signed-in user's own banked resets on a window, then returns the new meter. */
  useReset?(user: string, server: string, kind: string): Promise<unknown>;
  /** The signed-in user's own inbox items for one server, newest first. Open items only unless includeDone is set. */
  inbox?: { list(user: string, server: string, includeDone: boolean): Promise<InboxItem[]>; done(user: string, server: string, ids: string[] | 'all'): Promise<number> };
  setTranscript?(user: string, server: string, channel: string, enabled: boolean): Promise<unknown>;
  /** Live per-user view and send checks for the read and send routes. */
  access?: ChannelAccess;
  admin?: ConsoleAdmin;
  /** Read-only conversation transcripts, runs, search and the live stream. */
  conversations?: TranscriptRoutes;
  /** Private chats: list, create, rename, delete, messages, stream and send. Owner only. */
  chats?: ChatRoutes;
  /** Posts a web reply as the signed-in user. Errors with a WebReplyError keep their status. */
  reply?(user: string, server: string | undefined, channel: string, text: string): Promise<unknown>;
  /** Login sessions. The database is the source of truth, so logins survive restarts. */
  sessions: WebSessionStore;
}
/** siteDir is the landing page export. It defaults to site/out. */
export interface ConsoleOptions { origin: string; clientId: string; clientSecret: string; port: number; host: string; siteDir?: string }
export function consoleOptions(env: NodeJS.ProcessEnv = process.env): ConsoleOptions | undefined {
  if (env.WEB_ENABLED !== 'true') return undefined;
  const origin = new URL(env.WEB_ORIGIN || 'http://localhost:3000');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !['http:', 'https:'].includes(origin.protocol)) throw new Error('WEB_ORIGIN must be an HTTP(S) origin without a path, query, or fragment');
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error('Public WEB_ORIGIN must use HTTPS');
  const port = Number(env.WEB_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WEB_PORT');
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) throw new Error('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET for web login');
  return { origin: origin.origin, port, host: env.WEB_HOST || '127.0.0.1', clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET };
}
/** Build version for the console footer. The sha is null unless the image set a valid full git sha. */
export function consoleVersion(env: NodeJS.ProcessEnv = process.env) {
  const { commit, builtAt } = runtimeVersion(env);
  return { sha: commit ? commit.slice(0, 7).toLowerCase() : null, time: builtAt ? new Date(builtAt).toISOString() : null, url: commit ? `https://github.com/pretty-manageable-servers/slopbot/commit/${commit.toLowerCase()}` : null };
}
const token = () => randomBytes(32).toString('hex');
/** A login lasts 30 days after its last renewal. A request renews it once less than 29 days remain. */
const SESSION_MS = 30 * 86_400_000;
const SESSION_RENEW_MS = 29 * 86_400_000;
const SESSION_AGE = SESSION_MS / 1000;
const SESSION_SWEEP_MS = 3_600_000;
/** The database stores only this hash of the cookie value. */
const sessionHash = (id: string) => createHash('sha256').update(id).digest('hex');
const allowed = new Set(['calibration', 'monitoring', 'context', 'cooldown', 'channels', 'index', 'profile', 'timing', 'tool_display', 'default_effort']);
/** Team admin routes. Every one needs team membership; POST also needs an editing role, except the web key add and delete routes. */
async function adminRoute(admin: ConsoleAdmin, user: string, method: string, path: string, query: URLSearchParams, body: unknown): Promise<unknown> {
  const role = await admin.role(user);
  if (!role) throw new ToolError('Team membership is required.');
  const { panel } = admin;
  // Any team member can add and remove web search keys. Removing someone else's key needs an editor; the panel checks that.
  if (method === 'POST' && path === '/api/admin/web-keys/add') return panel.addWebKey(user, body);
  if (method === 'POST' && path === '/api/admin/web-keys/delete') return panel.deleteWebKey(user, await admin.canEdit(user), body);
  if (method === 'POST' && !await admin.canEdit(user)) throw new ToolError('Team editor role is required.');
  const info = (id: string) => admin.serverInfo(id);
  if (method === 'GET') {
    if (path === '/api/admin/me') return { role, canEdit: await admin.canEdit(user) };
    if (path === '/api/admin/limits') return panel.limits();
    if (path === '/api/admin/users') return panel.users(query.get('q') ?? '', Number(query.get('limit') ?? 10), Number(query.get('offset') ?? 0), info);
    if (path === '/api/admin/users/one') return panel.user(query.get('user'), info);
    if (path === '/api/admin/prices') return panel.prices();
    if (path === '/api/admin/system-prompt') return panel.systemPrompt();
    if (path === '/api/admin/bot-replies') return panel.botReplies();
    if (path === '/api/admin/servers') return admin.servers(serverPage(query));
    if (path === '/api/admin/servers/channels') return admin.serverChannels(snowflake(query.get('server'), 'server'));
    if (path === '/api/admin/usage/total') return panel.totalUsage(id => admin.serverInfo(id));
    if (path === '/api/admin/system-prompt/full') return panel.fullSystemPrompt();
    if (path === '/api/admin/web-keys') return panel.webKeys(user);
    return undefined;
  }
  if (path === '/api/admin/limits') return panel.saveLimits(body);
  if (path === '/api/admin/users/reset') return panel.resetUser(body, info);
  if (path === '/api/admin/users/grant') return panel.grantUser(body, info);
  if (path === '/api/admin/users/override') return panel.saveOverride(body, info);
  if (path === '/api/admin/web-keys/caps') return panel.saveKeyCaps(body);
  if (path === '/api/admin/web-keys/reset') return panel.resetWebKey(user, await admin.canEdit(user), body);
  if (path === '/api/admin/prices') return panel.savePrice(body);
  if (path === '/api/admin/system-prompt') return panel.saveSystemPrompt(body);
  if (path === '/api/admin/bot-replies') return panel.saveBotReplies(body);
  if (path === '/api/admin/transcripts') {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (typeof input.enabled !== 'boolean') throw new AdminInputError('Invalid web transcript setting.');
    return admin.setTranscript(snowflake(input.server, 'server'), snowflake(input.channel, 'channel'), input.enabled);
  }
  if (path === '/api/admin/web-webhooks/rotate') {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return admin.rotateWebhook(snowflake(input.server, 'server'), snowflake(input.channel, 'channel'));
  }
  return undefined;
}
type StaticFile = { content: Buffer; type: string };
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
const consoleCsp = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https://cdn.discordapp.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
// The Next static export uses inline scripts. Only the landing HTML gets this relaxation.
const landingCsp = consoleCsp.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
/** Console file for a /console path, or undefined. Only these names are served. */
const consoleFile = (path: string) => {
  if (path === '/console' || path === '/console/') return 'index.html';
  // Chat and channel addresses: /chat, /chat/<id>, /team, /team/<id> and /team/<id>/run/<runId>. The page reads the path.
  if (/^\/(chat|team)(\/[^/]+)?\/?$/.test(path) || /^\/team\/[^/]+\/run\/[^/]+\/?$/.test(path)) return 'index.html';
  const name = path.startsWith('/console/') ? path.slice('/console/'.length) : '';
  return /^(app\.js|palette\.js|conversations\.js|markdown\.js|highlight\.min\.js|style\.css|chat\.css|console\.css|shares\.js|shares\.css|assets\/(logo-(light|dark)\.svg|favicon\.svg|[a-z0-9-]+\.woff2))$/.test(name) ? name : undefined;
};
/** Landing file for a path: the home page, /_next/ files and top-level files such as /favicon.svg. */
// A path with no extension is a page of the export, for example /terms gives terms.html.
const landingFile = (path: string) => path === '/' ? 'index.html' : /^\/[a-z-]+$/.test(path) ? `${path.slice(1)}.html` : path.startsWith('/_next/') || /^\/[^/]+$/.test(path) ? path.slice(1) : undefined;
/** Reads a file under root. Missing files, folders, unknown types and paths that leave root give undefined. */
async function readInside(root: string, name: string): Promise<StaticFile | undefined> {
  const base = resolve(root), file = resolve(base, name), type = contentTypes[extname(file)];
  if (name.includes('..') || !file.startsWith(base + sep) || !type) return undefined;
  const info = await stat(file).catch(() => undefined);
  return info?.isFile() ? { content: await readFile(file), type } : undefined;
}
const noticePage = (title: string, text: string, link: [string, string][]) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/console/style.css"></head><body><main style="max-width:480px;margin:15vh auto;padding:0 16px;font-family:system-ui,sans-serif"><h1>${title}</h1><p>${text}</p><p>${link.map(([href, label]) => `<a href="${href}">${label}</a>`).join(' &middot; ')}</p></main></body></html>`;
export function createConsole(options: ConsoleOptions, backend: ConsoleBackend): Server {
  const sessions = backend.sessions;
  const states = new Map<string, number>();
  const cookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${options.origin.startsWith('https:') ? '; Secure' : ''}`;
  const cookies = (req: IncomingMessage) => Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=')));
  const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const sendFile = (res: ServerResponse, file: StaticFile | undefined) => { if (!file) return send(res, 404, { error: 'Not found.' }); res.setHeader('Content-Type', file.type); res.end(file.content); };
  const admin = async (res: ServerResponse, user: string, method: string, path: string, query: URLSearchParams, body: unknown) => {
    if (!backend.admin) return send(res, 404, { error: 'Not found.' });
    const value = await adminRoute(backend.admin, user, method, path, query, body);
    return value === undefined ? send(res, 404, { error: 'Not found.' }) : send(res, 200, value);
  };
  /** Finds the live login for a cookie value. Expired rows are deleted. A login close to its end is extended, and its cookie is sent again. */
  const loadSession = async (res: ServerResponse, id: string, now: number): Promise<{ user: string; csrf: string; hash: string } | undefined> => {
    if (!id) return undefined;
    const hash = sessionHash(id);
    const row = await sessions.getSession(hash);
    if (!row) return undefined;
    if (row.expires <= now) { await sessions.deleteSession(hash); return undefined; }
    if (row.expires - now < SESSION_RENEW_MS) {
      row.expires = now + SESSION_MS;
      await sessions.saveSession(row);
      res.setHeader('Set-Cookie', cookie('slopbot_session', id, SESSION_AGE));
    }
    return { user: row.user_id, csrf: row.csrf, hash };
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', consoleCsp);
    try {
      const url = new URL(req.url || '/', options.origin);
      const routePath = url.pathname;
      const now = Date.now();
      for (const [key, value] of states) if (value < now) states.delete(key);
      if (req.method === 'GET' && routePath === '/auth/login') {
        if (states.size >= 1000) return send(res, 429, { error: 'Try again later.' });
        const state = token(); states.set(state, now + 600_000);
        const auth = new URL('https://discord.com/oauth2/authorize');
        auth.search = new URLSearchParams({ client_id: options.clientId, redirect_uri: `${options.origin}/auth/callback`, response_type: 'code', scope: 'identify', state }).toString();
        res.writeHead(302, { Location: auth.href, 'Set-Cookie': cookie('slopbot_state', state, 600) }); res.end(); return;
      }
      if (req.method === 'GET' && routePath === '/auth/callback') {
        const state = url.searchParams.get('state');
        if (!state || cookies(req).slopbot_state !== state || !states.has(state)) return send(res, 400, { error: 'Login expired. Sign in again.' });
        states.delete(state);
        const code = url.searchParams.get('code');
        if (!code) return send(res, 400, { error: 'Discord login was cancelled.' });
        const response = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, grant_type: 'authorization_code', code, redirect_uri: `${options.origin}/auth/callback` }), signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('OAuth exchange failed');
        const data = await response.json() as { access_token: string };
        const identity = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${data.access_token}` }, signal: AbortSignal.timeout(15000) });
        if (!identity.ok) throw new Error('Identity lookup failed');
        const user = await identity.json() as { id: string };
        if (!/^\d{17,20}$/.test(user.id)) throw new Error('Invalid identity');
        const page = (status: number, html: string) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookie('slopbot_state', '', 0) }); res.end(html); };
        let member: boolean;
        try { member = await backend.canSignIn(user.id); }
        catch (error) { logError('web_signin_check_failed', error, { stage: 'web console' }); return page(503, noticePage('Could not sign you in', 'Slopbot could not check your Discord servers. Try again.', [['/auth/login', 'Try again']])); }
        if (!member) return page(403, noticePage('Slopbot is not in your servers', 'Slopbot is not in any of your Discord servers. Ask a server admin to add Slopbot, then sign in again.', [['/#start', 'Add to Discord'], ['/auth/login', 'Sign in again']]));
        await backend.snapshot(user.id);
        const id = token();
        await sessions.saveSession({ id_hash: sessionHash(id), user_id: user.id, csrf: token(), expires: now + SESSION_MS, created: now });
        res.writeHead(302, { Location: '/console', 'Set-Cookie': [cookie('slopbot_session', id, SESSION_AGE), cookie('slopbot_state', '', 0)] }); res.end(); return;
      }
      // Build version for the footer. Public: it needs no login and holds no secrets.
      if (req.method === 'GET' && routePath === '/api/version') return send(res, 200, consoleVersion());
      // Public share pages and snapshots. They never need a login and are never indexed.
      const shareImage = req.method === 'GET' && backend.shares ? routePath.match(/^\/s\/([A-Za-z0-9_-]{22})\/images\/([0-9a-f]{32}\.(?:png|jpg|gif|webp))$/) : null;
      if (shareImage && backend.shares) {
        res.setHeader('X-Robots-Tag', 'noindex');
        const image = await backend.shares.image(shareImage[1]!, shareImage[2]!);
        if (!image) return send(res, 404, { error: 'Not found.' });
        res.writeHead(200, { 'Content-Type': image.contentType, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(image.bytes); return;
      }
      if (req.method === 'GET' && backend.shares && (/^\/s\/[A-Za-z0-9_-]{22}$/.test(routePath) || /^\/api\/shares\/[A-Za-z0-9_-]{22}$/.test(routePath))) {
        res.setHeader('X-Robots-Tag', 'noindex');
        const shareId = routePath.slice(routePath.lastIndexOf('/') + 1);
        if (routePath.startsWith('/s/')) {
          const html = await backend.shares.page(shareId);
          if (!html) return send(res, 404, { error: 'Not found.' });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
        }
        const snapshot = await backend.shares.snapshot(shareId);
        return snapshot ? send(res, 200, snapshot) : send(res, 404, { error: 'Not found.' });
      }
      if (routePath.startsWith('/api/')) {
        const session = await loadSession(res, cookies(req).slopbot_session || '', now);
        // Transcript routes answer 403 without a session; their streams must not get a login redirect.
        if (req.method === 'GET' && backend.conversations?.handles(routePath)) return void await backend.conversations.handle(req, res, url, session?.user);
        if (!session) return send(res, 401, { error: 'Sign in with Discord to continue.' });
        // Private chats. The stream is GET. Writes need the same origin and CSRF checks as the other writes.
        if (backend.chats?.handles(routePath)) {
          if (req.method === 'GET') return void await backend.chats.handle(req, res, url, session.user, undefined);
          if (!['POST', 'PATCH', 'DELETE'].includes(req.method ?? '') || req.headers.origin !== new URL(options.origin).origin || req.headers['x-csrf-token'] !== session.csrf) return send(res, 403, { error: 'Invalid request.' });
          let chatBody: unknown;
          if (req.method === 'POST' && /^\/api\/chats\/[^/]+\/images$/.test(routePath)) {
            // One raw image per request. The size is checked on the header and again while reading.
            const limit = 25 * 1024 * 1024;
            if (!req.headers['content-type']?.startsWith('image/')) return send(res, 415, { error: 'Send an image.' });
            if (Number(req.headers['content-length']) > limit) { req.resume(); return send(res, 413, { error: 'Images can be 25 MB or smaller.' }); }
            const chunks: Buffer[] = []; let size = 0;
            // Past the limit nothing is kept. The rest of the body is read and dropped, so the 413 reaches the client.
            for await (const chunk of req) { size += chunk.length; if (size <= limit) chunks.push(chunk); }
            if (size > limit) return send(res, 413, { error: 'Images can be 25 MB or smaller.' });
            return void await backend.chats.handle(req, res, url, session.user, Buffer.concat(chunks));
          }
          if (req.method !== 'DELETE') {
            if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' });
            let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) return send(res, 413, { error: 'Request too large.' }); }
            try { chatBody = text ? JSON.parse(text) : {}; } catch { return send(res, 400, { error: 'Invalid JSON.' }); }
          }
          return void await backend.chats.handle(req, res, url, session.user, chatBody);
        }
        if (req.method === 'GET' && routePath === '/api/session' && backend.servers) {
          // The light start of the page: who signs in, the CSRF token and the server list. No channel or settings data.
          if (!(await backend.canSignIn(session.user))) { await sessions.deleteSession(session.hash); res.setHeader('Set-Cookie', cookie('slopbot_session', '', 0)); return send(res, 401, { error: 'Sign in with Discord to continue.' }); }
          return send(res, 200, { user: session.user, servers: await backend.servers(session.user), csrf: session.csrf });
        }
        if (req.method === 'GET' && routePath === '/api/settings') {
          const server = url.searchParams.get('server') ?? undefined;
          if (server !== undefined && !/^\d{17,20}$/.test(server)) return send(res, 400, { error: 'Invalid server.' });
          // A user who left every shared server loses the login.
          if (!(await backend.canSignIn(session.user))) { await sessions.deleteSession(session.hash); res.setHeader('Set-Cookie', cookie('slopbot_session', '', 0)); return send(res, 401, { error: 'Sign in with Discord to continue.' }); }
          return send(res, 200, { data: await backend.snapshot(session.user, server), csrf: session.csrf });
        }
        if (req.method === 'GET' && routePath.startsWith('/api/admin/')) return await admin(res, session.user, 'GET', routePath, url.searchParams, undefined);
        if (req.method === 'GET' && routePath === '/api/web-transcripts/channels') {
          const server = url.searchParams.get('server') ?? '';
          if (!/^\d{17,20}$/.test(server)) return send(res, 400, { error: 'Invalid server.' });
          if (!backend.transcripts) return send(res, 404, { error: 'Not found.' });
          return send(res, 200, await backend.transcripts(session.user, server));
        }
        if (req.method === 'GET' && routePath === '/api/usage') {
          const server = url.searchParams.get('server') ?? '';
          if (!/^\d{17,20}$/.test(server)) return send(res, 400, { error: 'Invalid server.' });
          if (!backend.usage) return send(res, 404, { error: 'Not found.' });
          return send(res, 200, await backend.usage(session.user, server));
        }
        const inboxList = routePath.match(/^\/api\/servers\/([^/]+)\/inbox$/);
        if (req.method === 'GET' && inboxList) {
          if (!/^\d{17,20}$/.test(inboxList[1]!)) return send(res, 400, { error: 'Invalid server.' });
          if (!backend.inbox) return send(res, 404, { error: 'Not found.' });
          return send(res, 200, { items: await backend.inbox.list(session.user, inboxList[1]!, url.searchParams.get('done') === '1') });
        }
        if (req.method === 'GET' && routePath === '/api/shares') {
          if (!backend.shares) return send(res, 404, { error: 'Not found.' });
          return send(res, 200, await backend.shares.list(session.user, url.searchParams.get('server') ?? ''));
        }
        if (req.method !== 'POST' || req.headers.origin !== new URL(options.origin).origin || req.headers['x-csrf-token'] !== session.csrf) return send(res, 403, { error: 'Invalid request.' });
        if (routePath === '/api/usage/reset') {
          if (!backend.useReset) return send(res, 404, { error: 'Not found.' });
          if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' });
          let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024) return send(res, 413, { error: 'Request too large.' }); }
          let input: { server?: unknown; kind?: unknown };
          try { input = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON.' }); }
          if (typeof input.server !== 'string' || !/^\d{17,20}$/.test(input.server)) return send(res, 400, { error: 'Invalid server.' });
          if (input.kind !== '5h' && input.kind !== 'week') return send(res, 400, { error: 'Invalid window.' });
          try { return send(res, 200, await backend.useReset(session.user, input.server, input.kind)); }
          catch (error) { if (error instanceof ToolError) return send(res, 409, { error: error.message }); throw error; }
        }
        const inboxDone = routePath.match(/^\/api\/servers\/([^/]+)\/inbox\/done$/);
        if (inboxDone) {
          if (!/^\d{17,20}$/.test(inboxDone[1]!)) return send(res, 400, { error: 'Invalid server.' });
          if (!backend.inbox) return send(res, 404, { error: 'Not found.' });
          if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' });
          let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return send(res, 413, { error: 'Request too large.' }); }
          let input: { ids?: unknown };
          try { input = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON.' }); }
          const ids = input?.ids;
          if (!(ids === 'all' || (Array.isArray(ids) && ids.length >= 1 && ids.length <= 100 && ids.every(id => typeof id === 'string')))) return send(res, 400, { error: 'Invalid inbox items.' });
          return send(res, 200, { changed: await backend.inbox.done(session.user, inboxDone[1]!, ids) });
        }
        const continued = routePath.match(/^\/api\/shares\/([A-Za-z0-9_-]{22})\/continue$/);
        if (continued) {
          // Needs no body. The CSRF check above already ran; the body is dropped unread.
          req.resume();
          if (!backend.continueShare) return send(res, 404, { error: 'Not found.' });
          return send(res, 201, await backend.continueShare(session.user, continued[1]!));
        }
        if (routePath === '/api/logout') { await sessions.deleteSession(session.hash); res.setHeader('Set-Cookie', cookie('slopbot_session', '', 0)); return send(res, 200, { ok: true }); }
        const conversation = routePath.match(/^\/api\/conversations\/(\d{17,20})\/reply$/);
        if (conversation) {
          if (!backend.reply) return send(res, 404, { error: 'Not found.' });
          if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' });
          let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return send(res, 413, { error: 'Request too large.' }); }
          let input: { server?: string; text?: string };
          try { input = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON.' }); }
          if (input?.server !== undefined && (typeof input.server !== 'string' || !/^\d{17,20}$/.test(input.server))) return send(res, 400, { error: 'Invalid server.' });
          try { return send(res, 201, await backend.reply(session.user, input?.server, conversation[1]!, typeof input?.text === 'string' ? input.text : '')); }
          catch (error) {
            if (error instanceof WebReplyError) return send(res, error.status, { error: error.message, ...(error.resetAt !== undefined ? { resetAt: error.resetAt } : {}) });
            throw error;
          }
        }
        if (!routePath.startsWith('/api/admin/') && !['/api/settings', '/api/mcp', '/api/web-transcripts/channels'].includes(routePath) && !isShareWrite(routePath)) return send(res, 404, { error: 'Not found.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' });
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > (routePath === '/api/mcp' ? 65536 : 16384)) return send(res, 413, { error: 'Request too large.' }); }
        let input: { server?: string; channel?: string; name?: string; args?: ToolArgs; enabled?: boolean };
        try { input = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON.' }); }
        if (input?.server !== undefined && (typeof input.server !== 'string' || !/^\d{17,20}$/.test(input.server))) return send(res, 400, { error: 'Invalid server.' });
        if (routePath.startsWith('/api/admin/')) return await admin(res, session.user, 'POST', routePath, url.searchParams, input);
        if (isShareWrite(routePath)) {
          if (!backend.shares) return send(res, 404, { error: 'Not found.' });
          if (routePath === '/api/shares') return send(res, 200, await backend.shares.create(session.user, input));
          if (routePath === '/api/shares/revoke-all') return send(res, 200, await backend.shares.revokeAll(session.user, input?.server));
          return send(res, 200, await backend.shares.revoke(session.user, routePath.split('/')[3]!));
        }
        if (routePath === '/api/mcp') {
          if (!backend.mcp) return send(res, 404, { error: 'MCP configuration is unavailable.' });
          return send(res, 200, await backend.mcp(session.user, input.server, input));
        }
        if (routePath === '/api/web-transcripts/channels') {
          const { server, channel, enabled } = input ?? {};
          if (!backend.setTranscript) return send(res, 404, { error: 'Not found.' });
          if (typeof server !== 'string' || !/^\d{17,20}$/.test(server) || typeof channel !== 'string' || !/^\d{17,20}$/.test(channel) || typeof enabled !== 'boolean') return send(res, 400, { error: 'Invalid web transcript setting.' });
          return send(res, 200, await backend.setTranscript(session.user, server, channel, enabled));
        }
        if (!input || typeof input.channel !== 'string' || typeof input.name !== 'string' || !allowed.has(input.name)) return send(res, 400, { error: 'Unsupported setting.' });
        if (input.name === 'profile' && !['set', 'remove', 'lock'].includes(String(input.args?.action))) return send(res, 400, { error: 'Unsupported profile action.' });
        return send(res, 200, await backend.invoke(session.user, input.server, input.channel, input.name, input.args || {}));
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
      const consoleName = consoleFile(routePath);
      if (consoleName) return sendFile(res, await readInside('web', consoleName));
      const landingName = landingFile(routePath);
      if (!landingName) return send(res, 404, { error: 'Not found.' });
      if (landingName.endsWith('.html')) res.setHeader('Content-Security-Policy', landingCsp);
      return sendFile(res, await readInside(options.siteDir ?? 'site/out', landingName));
    } catch (error) {
      if (error instanceof AdminInputError) return send(res, 400, { error: error.message });
      if (error instanceof ChatError) return send(res, error.status, { error: error.message, ...(error.resetAt !== undefined ? { resetAt: error.resetAt } : {}) });
      if (error instanceof ShareError) return send(res, error.status, { error: error.message });
      logError('web_console_failed', error, { stage: 'web console' });
      const info = describeError(error);
      send(res, error instanceof ToolError && error.status === 'rejected' ? 403 : 502, { error: errorSummary(error), code: info.code, recovery: info.recovery });
    }
  });
  // Expired logins are also removed on read. The sweep timer does not keep the process alive.
  const sweep = setInterval(() => { void sessions.deleteExpiredSessions(Date.now()).catch(error => logError('web_session_cleanup_failed', error, { stage: 'web console' })); }, SESSION_SWEEP_MS);
  sweep.unref();
  server.once('close', () => clearInterval(sweep));
  return server;
}
