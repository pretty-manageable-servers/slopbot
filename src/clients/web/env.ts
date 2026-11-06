import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { Context, Hono, MiddlewareHandler } from 'hono';

/** A live login: the user, the CSRF token for writes and the hash of the cookie (the session row key). */
export interface Session { user: string; csrf: string; hash: string }
/**
 * Bindings hold the raw Node request and response (SSE and dictation write to them). `out` holds the headers every
 * response carries unless it sets its own (no-store, nosniff, CSP, the renewed login cookie).
 */
export type WebEnv = { Bindings: HttpBindings; Variables: { session: Session | undefined; out: Headers; body: unknown } };
export type WebContext = Context<WebEnv>;
export type WebApp = Hono<WebEnv>;

export const json = (status: number, value: unknown): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
export const notFound = () => json(404, { error: 'Not found.' });
export const alreadySent = () => RESPONSE_ALREADY_SENT;
export const isAlreadySent = (res: Response) => res.headers.has('x-hono-already-sent');

/** The signed-in user. Routes after the session check can rely on it. */
export const userOf = (c: WebContext): string => c.get('session')!.user;

/** Copies the default headers onto the raw response. Call before a handler writes its own head on `c.env.outgoing`. */
export function applyOut(c: WebContext): void {
  for (const [key, value] of c.get('out')) c.env.outgoing.setHeader(key, value);
}

/**
 * The failure answer of a route group. After the head went out (a stream) nothing can be sent any more, so the
 * connection ends; before it, `answer` gives the response.
 */
export function failure(c: WebContext, answer: () => Response): Response {
  const { outgoing } = c.env;
  if (!outgoing.headersSent) return answer();
  if (!outgoing.writableEnded) outgoing.end();
  return RESPONSE_ALREADY_SENT;
}

/** What every route group needs from the console. */
export interface WebDeps {
  options: import('./web-console.js').ConsoleOptions;
  backend: import('./web-console.js').ConsoleBackend;
  /** A Set-Cookie value with the console's attributes (Secure on https). */
  cookie(name: string, value: string, age: number): string;
  /** Middleware for writes: 403 unless the method is in `methods` and the Origin and X-CSRF-Token match the login. */
  guard(methods?: string[]): MiddlewareHandler<WebEnv>;
}
