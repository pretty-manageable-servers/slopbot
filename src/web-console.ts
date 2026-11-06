import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { logError } from "./errors.js";
import type { ToolArgs } from './tools.js';
import type { ChannelAccess } from './channel-access.js';
import type { AdminPanel, ServerInfo, ServerPage } from './admin-panel.js';
import type { TeamRole } from './team-admins.js';
import type { TranscriptRoutes } from './web-transcripts.js';
import type { ShareService } from './shares.js';
import type { WebSessionStore } from './web-session-store.js';
import type { ChatRoutes } from './web-chats.js';
import type { PmAudio } from './adapters/audio.js';
import type { InboxItem } from './inbox.js';
import type { LlmMode } from './llm-mode.js';
import { widgetFrameLoader } from 'agentic-ui-kit/core';
import type { Json } from './domain.js';
import { createApp } from './clients/web/app.js';
import { SESSION_SWEEP_MS } from './clients/web/routes/auth.js';

export { consoleVersion } from './clients/web/routes/version.js';
export { WIDGET_FRAME_PATH, movedPath } from './clients/web/routes/static.js';

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
  /** Speech to text for composer dictation (POST /api/transcribe). Without it the route answers 503. */
  audio?: Pick<PmAudio, 'transcribeWav'> | undefined;
  /** Share links. Public page and snapshot routes, plus the admin list and writes. */
  shares?: ShareService;
  /** Copies a live share into a new private chat of the signed-in user. Errors with a ChatError keep their status. */
  continueShare?(user: string, shareId: string): Promise<unknown>;
  snapshot(user: string, server?: string): Promise<unknown>;
  /** True when the user shares at least one server with Slopbot. Throws when Discord cannot answer, so callers fail closed. */
  canSignIn(user: string): Promise<boolean>;
  /** The servers the user and Slopbot share, with the user's admin flag. Cached. Light: no channel or settings data. */
  servers?(user: string): Promise<{ id: string; name: string; icon: string | null; admin: boolean }[]>;
  /** The user's name and avatar as one server shows them (nickname and server avatar first). Undefined when unknown. */
  profile?(user: string, server: string): Promise<{ displayName: string; avatarUrl: string | null } | undefined>;
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
/** siteDir is the landing page export. It defaults to site/out. nextDir is the Vite build of the console (console/dist). llmStatus gives the signed-in user's LLM mode; without it the mode is normal. settings holds the non-ZDR switches. oauthBase replaces https://discord.com for local development only (see scripts/development/dev-oauth.mjs). */
export interface ConsoleOptions { origin: string; clientId: string; clientSecret: string; port: number; host: string; siteDir?: string; nextDir?: string; llmStatus?: (user: string) => { mode: LlmMode; canChat: boolean }; settings?: ConsoleSettings; oauthBase?: string }
/** Reads and writes of the non-ZDR switches. Users use the global scope; each server uses its own scope. */
export interface ConsoleSettings { setting(server: string, key: string): unknown; setSetting(server: string, key: string, value: Json): void | Promise<void> }
export function consoleOptions(env: NodeJS.ProcessEnv = process.env): ConsoleOptions | undefined {
  if (env.WEB_ENABLED !== 'true') return undefined;
  const origin = new URL(env.WEB_ORIGIN || 'http://localhost:3000');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !['http:', 'https:'].includes(origin.protocol)) throw new Error('WEB_ORIGIN must be an HTTP(S) origin without a path, query, or fragment');
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error('Public WEB_ORIGIN must use HTTPS');
  const oauthBase = env.WEB_OAUTH_BASE ? new URL(env.WEB_OAUTH_BASE) : undefined;
  if (oauthBase && (env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('WEB_OAUTH_BASE is for local development only');
  if (oauthBase && (!['http:', 'https:'].includes(oauthBase.protocol) || !['localhost', '127.0.0.1'].includes(oauthBase.hostname))) throw new Error('WEB_OAUTH_BASE must be an HTTP(S) URL on localhost or 127.0.0.1');
  const port = Number(env.WEB_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WEB_PORT');
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) throw new Error('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET for web login');
  return { origin: origin.origin, port, host: env.WEB_HOST || '127.0.0.1', clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET, ...(oauthBase ? { oauthBase: oauthBase.origin } : {}) };
}
/** The console's HTTP server. The routes are one Hono app (clients/web/app.ts) served on a node:http server, so callers listen and close it as before. */
export function createConsole(options: ConsoleOptions, backend: ConsoleBackend): Server {
  const app = createApp(options, backend, widgetFrameLoader);
  const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  // Expired logins are also removed on read. The sweep timer does not keep the process alive.
  const sweep = setInterval(() => { void backend.sessions.deleteExpiredSessions(Date.now()).catch(error => logError('web_session_cleanup_failed', error, { stage: 'web console' })); }, SESSION_SWEEP_MS);
  sweep.unref();
  server.once('close', () => clearInterval(sweep));
  return server;
}
