import { Hono } from 'hono';
import { logError } from '../../../errors.js';
import { SNOWFLAKE } from '../body.js';
import { alreadySent, failure, json, notFound, type WebContext, type WebEnv } from '../env.js';

/** Read-only conversation transcripts, runs, search and the live stream. Mounted at /api; answers GET only. */
export type TranscriptRoutes = Hono<WebEnv>;

/** What the routes call. `createTranscripts` in web-transcripts.ts builds it from the store. */
export interface TranscriptOps {
  list(server: string, user: string): Promise<Response>;
  search(url: URL, server: string, user: string): Promise<Response>;
  messages(url: URL, server: string, channel: string, user: string): Promise<Response>;
  used(url: URL, server: string, channel: string, user: string): Promise<Response>;
  runs(url: URL, server: string, channel: string, user: string): Promise<Response>;
  conversation(server: string, channel: string, runId: string, user: string): Promise<Response>;
  run(runId: string, user: string): Promise<Response>;
  /** Opens the engine event stream on the raw response (SSE, event name `engine`). Gives a response only when it refused before the stream started. */
  events(c: WebContext, server: string, channel: string, user: string): Promise<Response | undefined>;
  /** The saved engine events of one turn: `{ events }`. */
  turnEvents(server: string, channel: string, turn: string, user: string): Promise<Response>;
  /** Opens the live stream on the raw response. Gives a response only when it refused before the stream started. */
  stream(c: WebContext, server: string, channel: string, user: string): Promise<Response | undefined>;
}

export function conversationRoutes(ops: TranscriptOps): TranscriptRoutes {
  const app = new Hono<WebEnv>();
  const user = (c: WebContext) => c.get('session')?.user ?? '';
  const url = (c: WebContext) => new URL(c.req.url);
  app.onError((error, c) => failure(c, () => {
    logError('web_transcript_failed', error, { stage: 'web transcripts' });
    return json(502, { error: 'Could not load this conversation.' });
  }));

  // These routes answer 403 without a session; their streams must not get a login redirect.
  app.use('/runs/*', async (c, next) => c.req.method === 'GET' && !c.get('session') ? json(403, { error: 'Sign in with Discord to continue.' }) : next());
  app.use('/conversations/*', async (c, next) => c.req.method === 'GET' && !c.get('session') ? json(403, { error: 'Sign in with Discord to continue.' }) : next());
  app.get('/runs/:id', c => ops.run(c.req.param('id'), user(c)));
  app.get('/runs/*', () => notFound());

  const serverOf = (c: WebContext) => c.req.query('server') ?? '';
  app.use('/conversations/*', async (c, next) => c.req.method === 'GET' && !SNOWFLAKE.test(serverOf(c)) ? json(400, { error: 'Invalid server.' }) : next());
  app.get('/conversations', c => ops.list(serverOf(c), user(c)));
  app.get('/conversations/search', c => ops.search(url(c), serverOf(c), user(c)));
  app.use('/conversations/:channel/*', async (c, next) => c.req.method === 'GET' && !SNOWFLAKE.test(c.req.param('channel')) ? json(400, { error: 'Invalid conversation.' }) : next());
  app.get('/conversations/:channel/messages', c => ops.messages(url(c), serverOf(c), c.req.param('channel'), user(c)));
  app.get('/conversations/:channel/used', c => ops.used(url(c), serverOf(c), c.req.param('channel'), user(c)));
  app.get('/conversations/:channel/stream', async c => await ops.stream(c, serverOf(c), c.req.param('channel'), user(c)) ?? alreadySent());
  app.get('/conversations/:channel/events', async c => await ops.events(c, serverOf(c), c.req.param('channel'), user(c)) ?? alreadySent());
  app.get('/conversations/:channel/turns/:turn/events', c => ops.turnEvents(serverOf(c), c.req.param('channel'), c.req.param('turn'), user(c)));
  app.get('/conversations/:channel/runs', c => ops.runs(url(c), serverOf(c), c.req.param('channel'), user(c)));
  app.get('/conversations/:channel/runs/:run', c => ops.conversation(serverOf(c), c.req.param('channel'), c.req.param('run'), user(c)));
  app.get('/conversations/*', () => notFound());
  return app;
}
