import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { logError } from '../../../errors.js';
import type { MiddlewareHandler } from 'hono';
import { json, type WebContext, type WebDeps, type WebEnv } from '../env.js';

export const token = () => randomBytes(32).toString('hex');
/** A login lasts 30 days after its last renewal. A request renews it once less than 29 days remain. */
const SESSION_MS = 30 * 86_400_000;
const SESSION_RENEW_MS = 29 * 86_400_000;
export const SESSION_AGE = SESSION_MS / 1000;
export const SESSION_SWEEP_MS = 3_600_000;
/** The database stores only this hash of the cookie value. */
const sessionHash = (id: string) => createHash('sha256').update(id).digest('hex');

const noticePage = (title: string, text: string, link: [string, string][]) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/share/style.css"></head><body><main style="max-width:480px;margin:15vh auto;padding:0 16px;font-family:system-ui,sans-serif"><h1>${title}</h1><p>${text}</p><p>${link.map(([href, label]) => `<a href="${href}">${label}</a>`).join(' &middot; ')}</p></main></body></html>`;

/**
 * Finds the live login for the cookie on /api/ requests and keeps it in `session`. Expired rows are deleted. A login close
 * to its end is extended, and its cookie is sent again.
 */
export function sessionLoader({ backend, cookie }: WebDeps): MiddlewareHandler<WebEnv> {
  const { sessions } = backend;
  return async (c, next) => {
    if (!c.req.path.startsWith('/api/')) return next();
    c.set('session', undefined);
    const id = getCookie(c, 'slopbot_session') || '';
    const row = id ? await sessions.getSession(sessionHash(id)) : undefined;
    const hash = sessionHash(id);
    const now = Date.now();
    if (row && row.expires <= now) await sessions.deleteSession(hash);
    else if (row) {
      if (row.expires - now < SESSION_RENEW_MS) {
        row.expires = now + SESSION_MS;
        await sessions.saveSession(row);
        c.get('out').set('Set-Cookie', cookie('slopbot_session', id, SESSION_AGE));
      }
      c.set('session', { user: row.user_id, csrf: row.csrf, hash });
    }
    return next();
  };
}

/** Drops the login and its cookie. */
export async function endSession({ backend, cookie }: WebDeps, c: WebContext): Promise<void> {
  await backend.sessions.deleteSession(c.get('session')!.hash);
  c.get('out').set('Set-Cookie', cookie('slopbot_session', '', 0));
}

/** Discord OAuth: the redirect to Discord and the callback that creates the login. */
export function authRoutes({ options, backend, cookie }: WebDeps): Hono<WebEnv> {
  const app = new Hono<WebEnv>();
  const discord = options.oauthBase ?? 'https://discord.com';
  const states = new Map<string, number>();
  const sweep = (now: number) => { for (const [key, value] of states) if (value < now) states.delete(key); };
  app.get('/auth/login', () => {
    const now = Date.now();
    sweep(now);
    if (states.size >= 1000) return json(429, { error: 'Try again later.' });
    const state = token(); states.set(state, now + 600_000);
    const auth = new URL(`${discord}/oauth2/authorize`);
    auth.search = new URLSearchParams({ client_id: options.clientId, redirect_uri: `${options.origin}/auth/callback`, response_type: 'code', scope: 'identify', state }).toString();
    return new Response(null, { status: 302, headers: { Location: auth.href, 'Set-Cookie': cookie('slopbot_state', state, 600) } });
  });
  app.get('/auth/callback', async c => {
    const now = Date.now();
    sweep(now);
    const state = c.req.query('state');
    if (!state || getCookie(c, 'slopbot_state') !== state || !states.has(state)) return json(400, { error: 'Login expired. Sign in again.' });
    states.delete(state);
    const code = c.req.query('code');
    if (!code) return json(400, { error: 'Discord login was cancelled.' });
    const response = await fetch(`${discord}/api/oauth2/token`, { method: 'POST', body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, grant_type: 'authorization_code', code, redirect_uri: `${options.origin}/auth/callback` }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('OAuth exchange failed');
    const data = await response.json() as { access_token: string };
    const identity = await fetch(`${discord}/api/users/@me`, { headers: { Authorization: `Bearer ${data.access_token}` }, signal: AbortSignal.timeout(15000) });
    if (!identity.ok) throw new Error('Identity lookup failed');
    const user = await identity.json() as { id: string };
    if (!/^\d{17,20}$/.test(user.id)) throw new Error('Invalid identity');
    const page = (status: number, html: string) => new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookie('slopbot_state', '', 0) } });
    let member: boolean;
    try { member = await backend.canSignIn(user.id); }
    catch (error) { logError('web_signin_check_failed', error, { stage: 'web console' }); return page(503, noticePage('Could not sign you in', 'Slopbot could not check your Discord servers. Try again.', [['/auth/login', 'Try again']])); }
    if (!member) return page(403, noticePage('Slopbot is not in your servers', 'Slopbot is not in any of your Discord servers. Ask a server admin to add Slopbot, then sign in again.', [['/#start', 'Add to Discord'], ['/auth/login', 'Sign in again']]));
    await backend.snapshot(user.id);
    const id = token();
    await backend.sessions.saveSession({ id_hash: sessionHash(id), user_id: user.id, csrf: token(), expires: now + SESSION_MS, created: now });
    const headers = new Headers({ Location: '/console' });
    headers.append('Set-Cookie', cookie('slopbot_session', id, SESSION_AGE));
    headers.append('Set-Cookie', cookie('slopbot_state', '', 0));
    return new Response(null, { status: 302, headers });
  });
  return app;
}
