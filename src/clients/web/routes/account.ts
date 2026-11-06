import { z } from 'zod';
import { ToolError, type ToolArgs } from '../../../tools.js';
import { WebReplyError } from '../../../web-replies.js';
import { handleTranscribe, transcribeLimits } from '../web-transcribe.js';
import { SNOWFLAKE, check, looseBody, readInput, readJson, snowflakeField } from '../body.js';
import { alreadySent, applyOut, json, notFound, userOf, type WebApp, type WebContext, type WebDeps } from '../env.js';
import { endSession } from './auth.js';

const allowed = new Set(['calibration', 'monitoring', 'context', 'cooldown', 'channels', 'index', 'profile', 'timing', 'tool_display', 'default_effort', 'voice']);
/** The web may only read and set the voice style. Join, leave and propose need Discord. */
const webVoiceActions = new Set(['status', 'style']);

const resetBody = z.object({ server: snowflakeField('Invalid server.'), kind: z.enum(['5h', 'week'], { error: 'Invalid window.' }) }, { error: 'Invalid request.' });
const INBOX_ITEMS = 'Invalid inbox items.';
const inboxBody = z.object({ ids: z.union([z.literal('all'), z.array(z.string(), { error: INBOX_ITEMS }).min(1, INBOX_ITEMS).max(100, INBOX_ITEMS)], { error: INBOX_ITEMS }) }, { error: INBOX_ITEMS });
const replyBody = z.object({ server: snowflakeField('Invalid server.').optional(), text: z.unknown() });
const mcpBody = z.looseObject({ server: snowflakeField('Invalid server.').optional() }, { error: 'Invalid request.' });
const TRANSCRIPT = 'Invalid web transcript setting.';
const transcriptBody = z.object({ server: snowflakeField(TRANSCRIPT), channel: snowflakeField(TRANSCRIPT), enabled: z.boolean({ error: TRANSCRIPT }) }, { error: TRANSCRIPT });
const UNSUPPORTED = 'Unsupported setting.';
const settingBody = z.object({ server: z.string().optional(), channel: z.string({ error: UNSUPPORTED }), name: z.string({ error: UNSUPPORTED }).refine(name => allowed.has(name), UNSUPPORTED), args: z.unknown() }, { error: UNSUPPORTED });

/** The signed-in user's own routes: login state, settings, status, usage, inbox, replies, MCP and dictation. */
export function accountRoutes(app: WebApp, deps: WebDeps): void {
  const { options, backend, guard } = deps;
  const transcribeState = transcribeLimits();
  /** A user who left every shared server loses the login. */
  const stillMember = async (c: WebContext): Promise<boolean> => {
    if (await backend.canSignIn(userOf(c))) return true;
    await endSession(deps, c);
    return false;
  };
  const signIn = () => json(401, { error: 'Sign in with Discord to continue.' });
  const serverQuery = (c: WebContext) => c.req.query('server') ?? '';

  if (backend.servers) {
    const servers = backend.servers;
    // The light start of the page: who signs in, the CSRF token and the server list. No channel or settings data.
    app.get('/api/session', async c => {
      const session = c.get('session')!;
      if (!await stillMember(c)) return signIn();
      const list = await servers(session.user);
      // The name and avatar for the account row, from the first server. The page shows the user ID without them.
      const found = list[0] && backend.profile ? await backend.profile(session.user, list[0].id).catch(() => undefined) : undefined;
      const me = found ? { displayName: found.displayName, avatarUrl: found.avatarUrl } : null;
      return json(200, { user: session.user, me, servers: list, csrf: session.csrf });
    });
  }
  app.get('/api/settings', async c => {
    const server = c.req.query('server');
    if (server !== undefined && !SNOWFLAKE.test(server)) return json(400, { error: 'Invalid server.' });
    if (!await stillMember(c)) return signIn();
    return json(200, { data: await backend.snapshot(userOf(c), server), csrf: c.get('session')!.csrf });
  });
  // The LLM mode for the banner and the composer. Without llmStatus the model is always up.
  app.get('/api/status', c => {
    const status = options.llmStatus?.(userOf(c)) ?? { mode: 'normal' as const, canChat: true };
    return json(200, { mode: status.mode, canChat: status.canChat });
  });
  app.get('/api/web-transcripts/channels', async c => {
    if (!SNOWFLAKE.test(serverQuery(c))) return json(400, { error: 'Invalid server.' });
    if (!backend.transcripts) return notFound();
    return json(200, await backend.transcripts(userOf(c), serverQuery(c)));
  });
  app.get('/api/usage', async c => {
    if (!SNOWFLAKE.test(serverQuery(c))) return json(400, { error: 'Invalid server.' });
    if (!backend.usage) return notFound();
    return json(200, await backend.usage(userOf(c), serverQuery(c)));
  });
  app.get('/api/servers/:server/inbox', async c => {
    const server = c.req.param('server');
    if (!SNOWFLAKE.test(server)) return json(400, { error: 'Invalid server.' });
    if (!backend.inbox) return notFound();
    return json(200, { items: await backend.inbox.list(userOf(c), server, c.req.query('done') === '1') });
  });

  // Dictation checks the Origin and CSRF token itself and answers on the raw response.
  app.post('/api/transcribe', async c => {
    applyOut(c);
    await handleTranscribe(c.env.incoming, c.env.outgoing, c.get('session')!, { audio: backend.audio, origin: options.origin, limits: transcribeState });
    return alreadySent();
  });

  app.post('/api/usage/reset', guard(), async c => {
    if (!backend.useReset) return notFound();
    const body = await readJson(c, 1024);
    if ('error' in body) return body.error;
    const input = check(resetBody, body.value);
    if ('error' in input) return input.error;
    try { return json(200, await backend.useReset(userOf(c), input.value.server, input.value.kind)); }
    catch (error) { if (error instanceof ToolError) return json(409, { error: error.message }); throw error; }
  });
  app.post('/api/servers/:server/inbox/done', guard(), async c => {
    const server = c.req.param('server');
    if (!SNOWFLAKE.test(server)) return json(400, { error: 'Invalid server.' });
    if (!backend.inbox) return notFound();
    const body = await readJson(c, 16384);
    if ('error' in body) return body.error;
    const input = check(inboxBody, looseBody(body.value));
    if ('error' in input) return input.error;
    return json(200, { changed: await backend.inbox.done(userOf(c), server, input.value.ids) });
  });
  app.post('/api/logout', guard(), async c => { await endSession(deps, c); return json(200, { ok: true }); });
  app.post('/api/conversations/:channel/reply', guard(), async c => {
    const channel = c.req.param('channel');
    if (!SNOWFLAKE.test(channel)) return notFound();
    if (!backend.reply) return notFound();
    const body = await readJson(c, 16384);
    if ('error' in body) return body.error;
    const input = check(replyBody, looseBody(body.value));
    if ('error' in input) return input.error;
    try { return json(201, await backend.reply(userOf(c), input.value.server, channel, typeof input.value.text === 'string' ? input.value.text : '')); }
    catch (error) {
      if (error instanceof WebReplyError) return json(error.status, { error: error.message, ...(error.resetAt !== undefined ? { resetAt: error.resetAt } : {}) });
      throw error;
    }
  });

  app.post('/api/mcp', guard(), async c => {
    const body = await readInput(c, 65536);
    if ('error' in body) return body.error;
    if (!backend.mcp) return json(404, { error: 'MCP configuration is unavailable.' });
    const input = check(mcpBody, body.value);
    if ('error' in input) return input.error;
    return json(200, await backend.mcp(userOf(c), input.value.server, input.value));
  });
  app.post('/api/web-transcripts/channels', guard(), async c => {
    const body = await readInput(c, 16384);
    if ('error' in body) return body.error;
    if (!backend.setTranscript) return notFound();
    const input = check(transcriptBody, looseBody(body.value));
    if ('error' in input) return input.error;
    return json(200, await backend.setTranscript(userOf(c), input.value.server, input.value.channel, input.value.enabled));
  });
  // The settings write: one named setting of one channel, from the allowed list.
  app.post('/api/settings', guard(), async c => {
    const body = await readInput(c, 16384);
    if ('error' in body) return body.error;
    const input = check(settingBody, body.value);
    if ('error' in input) return input.error;
    const { server, channel, name } = input.value, args = (input.value.args || {}) as ToolArgs;
    if (name === 'voice' && !webVoiceActions.has(String((input.value.args as { action?: unknown } | undefined)?.action))) return json(400, { error: UNSUPPORTED });
    if (name === 'profile' && !['set', 'remove', 'lock'].includes(String(args.action))) return json(400, { error: 'Unsupported profile action.' });
    return json(200, await backend.invoke(userOf(c), server, channel, name, args));
  });
}
