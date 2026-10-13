import { describeError, errorSummary, logError } from "./errors.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ToolError, type ToolArgs } from './tools.js';

export interface ConsoleBackend {
  snapshot(user: string): Promise<unknown>;
  invoke(user: string, channel: string, name: string, args: ToolArgs): Promise<unknown>;
  mcp?(user: string, input: unknown): Promise<unknown>;
}
export interface ConsoleOptions { origin: string; clientId: string; clientSecret: string; port: number; host: string }
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
const token = () => randomBytes(32).toString('hex');
const allowed = new Set(['monitoring', 'context', 'cooldown', 'channels', 'index', 'profile', 'timing', 'tool_display']);
export function createConsole(options: ConsoleOptions, backend: ConsoleBackend): Server {
  const sessions = new Map<string, { user: string; csrf: string; expires: number }>();
  const states = new Map<string, number>();
  const cookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${options.origin.startsWith('https:') ? '; Secure' : ''}`;
  const cookies = (req: IncomingMessage) => Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=')));
  const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url || '/', options.origin);
      const routePath = url.pathname;
      const now = Date.now();
      for (const [key, value] of states) if (value < now) states.delete(key);
      for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
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
        await backend.snapshot(user.id);
        if (sessions.size >= 1000) return send(res, 429, { error: 'Try again later.' });
        const id = token(); sessions.set(id, { user: user.id, csrf: token(), expires: now + 3_600_000 });
        res.writeHead(302, { Location: '/', 'Set-Cookie': [cookie('slopbot_session', id, 3600), cookie('slopbot_state', '', 0)] }); res.end(); return;
      }
      if (routePath.startsWith('/api/')) {
        const id = cookies(req).slopbot_session || '', session = sessions.get(id);
        if (!session) return send(res, 401, { error: 'Sign in with Discord to continue.' });
        if (req.method === 'GET' && routePath === '/api/settings') return send(res, 200, { data: await backend.snapshot(session.user), csrf: session.csrf });
        if (req.method !== 'POST' || req.headers.origin !== new URL(options.origin).origin || req.headers['x-csrf-token'] !== session.csrf) return send(res, 403, { error: 'Invalid request.' });
        if (routePath === '/api/logout') { sessions.delete(id); res.setHeader('Set-Cookie', cookie('slopbot_session', '', 0)); return send(res, 200, { ok: true }); }
        if (!['/api/settings', '/api/mcp'].includes(routePath)) return send(res, 404, { error: 'Not found.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' });
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > (routePath === '/api/mcp' ? 65536 : 16384)) return send(res, 413, { error: 'Request too large.' }); }
        let input: { channel?: string; name?: string; args?: ToolArgs };
        try { input = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON.' }); }
        if (routePath === '/api/mcp') {
          if (!backend.mcp) return send(res, 404, { error: 'MCP configuration is unavailable.' });
          return send(res, 200, await backend.mcp(session.user, input));
        }
        if (!input || typeof input.channel !== 'string' || typeof input.name !== 'string' || !allowed.has(input.name)) return send(res, 400, { error: 'Unsupported setting.' });
        if (input.name === 'profile' && !['set', 'remove', 'lock'].includes(String(input.args?.action))) return send(res, 400, { error: 'Unsupported profile action.' });
        return send(res, 200, await backend.invoke(session.user, input.channel, input.name, input.args || {}));
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
      const assets: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/assets/logo-light.svg': 'assets/logo-light.svg', '/assets/logo-dark.svg': 'assets/logo-dark.svg' };
      const file = assets[routePath];
      if (!file && !/^\/assets\/[a-z0-9-]+\.woff2$/.test(routePath)) return send(res, 404, { error: 'Not found.' });
      let content = await readFile(resolve('web', file || routePath.slice(1)));
      res.setHeader('Content-Type', routePath.endsWith('.js') ? 'text/javascript' : routePath.endsWith('.css') ? 'text/css' : routePath.endsWith('.svg') ? 'image/svg+xml' : routePath.endsWith('.woff2') ? 'font/woff2' : 'text/html');
      res.end(content);
    } catch (error) {
      logError('web_console_failed', error, { stage: 'web console' });
      const info = describeError(error);
      send(res, error instanceof ToolError && error.status === 'rejected' ? 403 : 502, { error: errorSummary(error), code: info.code, recovery: info.recovery });
    }
  });
}
