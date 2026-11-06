import { Hono } from 'hono';
import { describeError, errorSummary, logError } from '../../errors.js';
import { ToolError } from '../../tools.js';
import { AdminInputError } from '../../admin-panel.js';
import { ShareError } from '../../shares.js';
import { ChatError } from './web-chats.js';
import type { ConsoleBackend, ConsoleOptions } from './web-console.js';
import { failure, isAlreadySent, json, type WebApp, type WebDeps, type WebEnv } from './env.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes, sessionLoader } from './routes/auth.js';
import { publicShareRoutes, shareRoutes } from './routes/shares.js';
import { consoleCsp, staticRoutes } from './routes/static.js';
import { versionRoutes } from './routes/version.js';

/**
 * The console's web server as one Hono app. Routes run in registration order, and the order is the check order:
 * public pages, then the login check, then the transcript and chat routes, then the other routes (each write checks the
 * Origin and CSRF token first), then the static files.
 */
export function createApp(options: ConsoleOptions, backend: ConsoleBackend, widgetFrame: string): WebApp {
  const app = new Hono<WebEnv>();
  const cookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${options.origin.startsWith('https:') ? '; Secure' : ''}`;
  const origin = new URL(options.origin).origin;
  const guard: WebDeps['guard'] = (methods = ['POST']) => async (c, next) => {
    if (!methods.includes(c.req.method) || c.req.header('origin') !== origin || c.req.header('x-csrf-token') !== c.get('session')?.csrf) return json(403, { error: 'Invalid request.' });
    return next();
  };
  const deps: WebDeps = { options, backend, cookie, guard };

  app.onError((error, c) => failure(c, () => {
    if (error instanceof AdminInputError) return json(400, { error: error.message });
    if (error instanceof ChatError) return json(error.status, { error: error.message, ...(error.resetAt !== undefined ? { resetAt: error.resetAt } : {}) });
    if (error instanceof ShareError) return json(error.status, { error: error.message });
    logError('web_console_failed', error, { stage: 'web console' });
    const info = describeError(error);
    return json(error instanceof ToolError && error.status === 'rejected' ? 403 : 502, { error: errorSummary(error), code: info.code, recovery: info.recovery });
  }));

  // Every response carries these unless it sets its own.
  app.use('*', async (c, next) => {
    c.set('out', new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': consoleCsp }));
    await next();
    if (isAlreadySent(c.res)) return;
    for (const [key, value] of c.get('out')) if (!c.res.headers.has(key)) c.res.headers.set(key, value);
  });

  app.route('/', authRoutes(deps));
  publicShareRoutes(app, deps);
  versionRoutes(app);
  app.use('*', sessionLoader(deps));
  // Transcript routes answer 403 without a session; their streams must not get a login redirect.
  if (backend.conversations) app.route('/api', backend.conversations);
  app.use('*', async (c, next) => c.req.path.startsWith('/api/') && !c.get('session') ? json(401, { error: 'Sign in with Discord to continue.' }) : next());
  accountRoutes(app, deps);
  // Private chats. The stream is GET. Writes need the same origin and CSRF checks as the other writes.
  if (backend.chats) {
    const writes = guard(['POST', 'PATCH', 'DELETE']);
    app.use('/api/chats/*', (c, next) => c.req.method === 'GET' ? next() : writes(c, next));
    app.route('/api/chats', backend.chats);
  }
  shareRoutes(app, deps);
  adminRoutes(app, deps);
  app.all('/api/*', guard(), () => json(404, { error: 'Not found.' }));
  staticRoutes(app, deps, widgetFrame);
  return app;
}
