import { z } from 'zod';
import { ToolError } from '../../../tools.js';
import { AdminInputError, serverPage, snowflake } from '../../../admin-panel.js';
import type { ConsoleAdmin } from '../../../web-console.js';
import { GLOBAL_SETTINGS_SCOPE } from '../../../usage-cost.js';
import { SERVER_NON_ZDR_SETTING, USER_NON_ZDR_SETTING } from '../../../llm-mode.js';
import { looseBody, readInput } from '../body.js';
import { json, notFound, userOf, type WebApp, type WebDeps } from '../env.js';

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
    if (path === '/api/admin/schedule-limits') return panel.scheduleLimits();
    if (path === '/api/admin/servers') return admin.servers(serverPage(query));
    if (path === '/api/admin/servers/channels') return admin.serverChannels(snowflake(query.get('server'), 'server'));
    if (path === '/api/admin/usage/total') return panel.totalUsage(id => admin.serverInfo(id));
    if (path === '/api/admin/system-prompt/full') return panel.fullSystemPrompt();
    if (path === '/api/admin/web-keys') return panel.webKeys(user);
    if (path === '/api/admin/llm') return panel.llm();
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
  if (path === '/api/admin/schedule-limits') return panel.saveScheduleLimits(body);
  if (path === '/api/admin/llm') return panel.saveLlm(body);
  if (path === '/api/admin/llm/test') return panel.testLlm();
  if (path === '/api/admin/transcripts') {
    const input = looseBody(body);
    if (typeof input.enabled !== 'boolean') throw new AdminInputError('Invalid web transcript setting.');
    return admin.setTranscript(snowflake(input.server, 'server'), snowflake(input.channel, 'channel'), input.enabled);
  }
  if (path === '/api/admin/web-webhooks/rotate') {
    const input = looseBody(body);
    return admin.rotateWebhook(snowflake(input.server, 'server'), snowflake(input.channel, 'channel'));
  }
  return undefined;
}

/** Team routes for the non-ZDR switch. Reading needs membership; writing needs an editor. The errors match adminRoute's. */
async function teamAccess(admin: ConsoleAdmin, user: string, editor: boolean): Promise<void> {
  if (!await admin.role(user)) throw new ToolError('Team membership is required.');
  if (editor && !await admin.canEdit(user)) throw new ToolError('Team editor role is required.');
}

const allowBody = z.object({ allow: z.boolean({ error: 'Send allow as true or false.' }) }, { error: 'Send allow as true or false.' });
const serverAllowBody = z.object({ server: z.unknown(), allow: z.boolean({ error: 'Send allow as true or false.' }) }, { error: 'Send allow as true or false.' });

/** Team admin routes and the non-ZDR switches (the user's own and each server's). */
export function adminRoutes(app: WebApp, { options, backend, guard }: WebDeps): void {
  // Writes of the non-ZDR switches run one at a time. A user's write reads the whole record first, so two saves must not interleave.
  let settingWrites: Promise<unknown> = Promise.resolve();
  const queueSetting = (write: () => Promise<void>): Promise<void> => { const next = settingWrites.then(write); settingWrites = next.catch(() => undefined); return next; };
  const run = async (user: string, method: string, path: string, query: URLSearchParams, body: unknown) => {
    if (!backend.admin) return notFound();
    const value = await adminRoute(backend.admin, user, method, path, query, body);
    return value === undefined ? notFound() : json(200, value);
  };

  app.get('/api/settings/non-zdr', c => {
    if (!options.settings) return notFound();
    const saved = options.settings.setting(GLOBAL_SETTINGS_SCOPE, USER_NON_ZDR_SETTING) as Record<string, unknown> | null | undefined;
    return json(200, { allow: saved?.[userOf(c)] === true });
  });
  app.get('/api/admin/servers/non-zdr', async c => {
    if (!options.settings || !backend.admin) return notFound();
    await teamAccess(backend.admin, userOf(c), false);
    return json(200, { allow: options.settings.setting(snowflake(c.req.query('server') ?? null, 'server'), SERVER_NON_ZDR_SETTING) === true });
  });
  app.get('/api/admin/*', c => run(userOf(c), 'GET', c.req.path, new URL(c.req.url).searchParams, undefined));

  app.post('/api/settings/non-zdr', guard(), async c => {
    const body = await readInput(c, 16384);
    if ('error' in body) return body.error;
    if (!options.settings) return notFound();
    const parsed = allowBody.safeParse(looseBody(body.value));
    if (!parsed.success) throw new AdminInputError('Send allow as true or false.');
    const { allow } = parsed.data, store = options.settings, user = userOf(c);
    await queueSetting(async () => {
      const next: Record<string, boolean> = { ...(store.setting(GLOBAL_SETTINGS_SCOPE, USER_NON_ZDR_SETTING) as Record<string, boolean> | null | undefined) };
      if (allow) next[user] = true; else delete next[user];
      await store.setSetting(GLOBAL_SETTINGS_SCOPE, USER_NON_ZDR_SETTING, next);
    });
    return json(200, { allow });
  });
  app.post('/api/admin/servers/non-zdr', guard(), async c => {
    const body = await readInput(c, 16384);
    if ('error' in body) return body.error;
    if (!options.settings || !backend.admin) return notFound();
    await teamAccess(backend.admin, userOf(c), true);
    const input = looseBody(body.value);
    const server = snowflake(input.server, 'server');
    const parsed = serverAllowBody.safeParse(input);
    if (!parsed.success) throw new AdminInputError('Send allow as true or false.');
    const { allow } = parsed.data, store = options.settings;
    await queueSetting(async () => { await store.setSetting(server, SERVER_NON_ZDR_SETTING, allow); });
    return json(200, { allow });
  });
  app.post('/api/admin/*', guard(), async c => {
    const body = await readInput(c, 16384);
    if ('error' in body) return body.error;
    return run(userOf(c), 'POST', c.req.path, new URL(c.req.url).searchParams, body.value);
  });
}
