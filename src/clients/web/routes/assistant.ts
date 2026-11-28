import { Hono } from 'hono';
import { z } from 'zod';
import { EFFORTS } from '../../../domain.js';
import { ToolError } from '../../../errors.js';
import type { AssistantStore } from '../../../assistant/store.js';
import {
  assistantHomeChannel, MAX_GOAL_CHARS,
  type ActivityItem, type ApprovalRequest, type AssistantLimits, type AssistantSettings, type AssistantTask,
} from '../../../assistant/types.js';
import { nextRun, validateWhen, scheduleLimits } from '../../../schedules/schedule-time.js';
import { checkCronWake } from '../../../assistant/tools.js';
import { check, looseBody, readJson } from '../body.js';
import { json, notFound, userOf, type WebEnv } from '../env.js';

/** The assistant routes, mounted at /api/assistant. The console checks the session, the Origin and the CSRF token before them. */
export type AssistantRoutes = Hono<WebEnv>;

/** What the routes need from the assistant. The gate and the connectors are built elsewhere; the routes only call them. */
export interface AssistantBackend {
  store: AssistantStore;
  gate: {
    /** Runs the approved tool call. `always` also adds an allow rule for that tool to the sprout. */
    execute(id: string, user: string, always: boolean): Promise<void>;
    deny(id: string, user: string): Promise<void>;
  };
  connectors: {
    list(user: string): Promise<unknown[]>;
    put(user: string, body: { name: string; url: string; token?: string | undefined }): Promise<void>;
    remove(user: string, name: string): Promise<void>;
  };
  limits(): Promise<AssistantLimits>;
  ensureHomeChat(user: string): Promise<void>;
  now?: () => number;
}

/** Caps the JSON body of a write. Only stops abuse: the fields have their own limits. */
const JSON_MAX_BYTES = 256 * 1024;
/** Unread is counted over the newest activity only. The store has no count query. */
const UNREAD_SCAN = 100;
const MAX_READ_IDS = 100;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

const defaultSettings = (user: string): AssistantSettings => ({
  user, enabled: false, briefCron: null, timezone: 'UTC', dmUpdates: true, quietStart: null, quietEnd: null, updated: 0,
});

const zoneExists = (zone: string) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
};

const settingsBody = z.object({
  enabled: z.boolean().optional(),
  briefCron: z.string().nullable().optional(),
  timezone: z.string().optional(),
  dmUpdates: z.boolean().optional(),
  quietStart: z.string().regex(CLOCK, 'Invalid quiet time.').nullable().optional(),
  quietEnd: z.string().regex(CLOCK, 'Invalid quiet time.').nullable().optional(),
});

const activityQuery = z.object({
  before: z.coerce.number().int('Invalid before.').optional(),
  limit: z.coerce.number().int('Invalid limit.').min(1, 'Invalid limit.').max(50, 'Invalid limit.').default(20),
});

const readBody = z.object({ ids: z.array(z.string()).max(MAX_READ_IDS, 'Too many ids.') });

const taskAction = z.object({ action: z.enum(['approve', 'decline', 'pause', 'resume', 'cancel']) });

const wakeBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), minutes: z.number().int('Invalid wake.').min(1, 'Invalid wake.') }),
  z.object({ kind: z.literal('cron'), cron: z.string().min(1, 'Invalid wake.'), timezone: z.string().min(1, 'Invalid wake.') }),
]);

const taskEdit = z.object({
  goal: z.string().trim().min(1, 'Goal is required.').max(MAX_GOAL_CHARS, 'Goal is too long.').optional(),
  instructions: z.string().optional(),
  wake: wakeBody.optional(),
  rules: z.record(z.string(), z.enum(['allow', 'ask', 'block'])).optional(),
  effort: z.enum(EFFORTS).optional(),
  revision: z.number().int('Invalid revision.').min(0, 'Invalid revision.'),
});

const decisionBody = z.object({ decision: z.enum(['approve', 'deny']), always: z.boolean().optional() });

const connectorBody = z.object({
  name: z.string().min(1, 'Invalid name.'),
  url: z.url('Invalid url.'),
  token: z.string().optional(),
});
const connectorQuery = z.object({ name: z.string().min(1, 'Invalid name.') });

const CHANGED = () => json(409, { error: 'Changed. Reload.' });

/** The fields a body sets. Absent fields are dropped, so they keep their stored value. */
const given = <T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * The next state of a sprout for an owner action, or null when the action does not apply to the current status.
 * Approve and resume set nextAt to now so the sprout runs at the next tick.
 */
function afterAction(task: AssistantTask, action: z.infer<typeof taskAction>['action'], now: number): AssistantTask | null {
  switch (action) {
    case 'approve': return task.status === 'proposed' ? { ...task, status: 'active', nextAt: now } : null;
    case 'decline': return task.status === 'proposed' ? { ...task, status: 'declined' } : null;
    case 'pause': return task.status === 'active' ? { ...task, status: 'paused', pause: 'owner' } : null;
    case 'resume': return task.status === 'paused' ? { ...task, status: 'active', pause: null, failures: 0, nextAt: now } : null;
    case 'cancel': return ['proposed', 'active', 'paused'].includes(task.status) ? { ...task, status: 'cancelled', nextAt: null } : null;
  }
}

/** The assistant routes: the signed-in user's settings, activity, sprouts, approvals and connectors. */
export function assistantRoutes(backend: AssistantBackend): AssistantRoutes {
  const { store, gate, connectors } = backend;
  const now = () => backend.now?.() ?? Date.now();
  const app = new Hono<WebEnv>();

  // Writes carry a JSON body. It is parsed once here and checked by each route.
  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'DELETE') return next();
    const body = await readJson(c, JSON_MAX_BYTES, true);
    if ('error' in body) return body.error;
    c.set('body', body.value);
    return next();
  });

  /** The sprout when the signed-in user owns it. Another user's sprout is not found. */
  const ownTask = async (user: string, id: string) => {
    const task = await store.task(id);
    return task && task.owner === user ? task : undefined;
  };

  /** Throws ToolError when a cron wake is invalid. Zone and cron checks come from the schedule rules. */
  const checkCron = (cron: string, timezone: string, at: number) => validateWhen(
    { kind: 'cron', cron, timezone }, 'prompt', scheduleLimits(undefined), new Date(at),
  );

  app.get('/', async c => {
    const user = userOf(c);
    await backend.ensureHomeChat(user);
    const [settings, tasks, pending, recent] = await Promise.all([
      store.settings(user), store.tasks(user), store.pendingApprovals(user), store.activity(user, null, UNREAD_SCAN),
    ]);
    const unread = recent.filter(item => item.readAt === null).length;
    return json(200, {
      settings: settings ?? defaultSettings(user), tasks, pending, unread, homeChat: assistantHomeChannel(user),
    });
  });

  app.put('/settings', async c => {
    const user = userOf(c);
    const parsed = check(settingsBody, looseBody(c.get('body')));
    if ('error' in parsed) return parsed.error;
    const current = (await store.settings(user)) ?? defaultSettings(user);
    const next: AssistantSettings = { ...current, ...given(parsed.value), user, updated: now() };
    if (!zoneExists(next.timezone)) return json(400, { error: 'Invalid timezone.' });
    if (next.briefCron !== null) {
      try { checkCron(next.briefCron, next.timezone, now()); } catch (error) {
        if (error instanceof ToolError) return json(400, { error: error.message });
        throw error;
      }
    }
    await store.putSettings(next);
    // The next brief time depends on the cron and the zone, so it is recomputed when either changes.
    if (next.briefCron !== current.briefCron || next.timezone !== current.timezone) {
      const at = next.briefCron === null ? null : nextRun({ kind: 'cron', cron: next.briefCron, timezone: next.timezone }, new Date(now()));
      await store.setBriefNextAt(user, at ? at.getTime() : null);
    }
    return json(200, { settings: next });
  });

  app.get('/activity', async c => {
    const parsed = check(activityQuery, c.req.query());
    if ('error' in parsed) return parsed.error;
    const items: ActivityItem[] = await store.activity(userOf(c), parsed.value.before ?? null, parsed.value.limit);
    return json(200, { items });
  });

  app.post('/activity/read', async c => {
    const parsed = check(readBody, looseBody(c.get('body')));
    if ('error' in parsed) return parsed.error;
    await store.markRead(userOf(c), parsed.value.ids, now());
    return json(200, { ok: true });
  });

  app.post('/tasks/:id', async c => {
    const user = userOf(c);
    const parsed = check(taskAction, looseBody(c.get('body')));
    if ('error' in parsed) return parsed.error;
    const task = await ownTask(user, c.req.param('id'));
    if (!task) return notFound();
    const at = now();
    const action = parsed.value.action;
    const next = afterAction(task, action, at);
    if (!next) return json(409, { error: `Cannot ${action} this sprout now.` });
    if (action === 'approve') {
      const limits = await backend.limits();
      const active = (await store.tasks(user)).filter(item => item.status === 'active').length;
      if (active >= limits.maxActiveTasks) return json(422, { error: `Limit reached: ${limits.maxActiveTasks} active sprouts.` });
    }
    const saved: AssistantTask = { ...next, updatedAt: at, revision: task.revision + 1 };
    if (!(await store.putTask(saved, task.revision))) return CHANGED();
    return json(200, { task: saved });
  });

  app.patch('/tasks/:id', async c => {
    const user = userOf(c);
    const parsed = check(taskEdit, looseBody(c.get('body')));
    if ('error' in parsed) return parsed.error;
    const task = await ownTask(user, c.req.param('id'));
    if (!task) return notFound();
    const { revision, wake, ...edit } = parsed.value;
    const at = now();
    const limits = await backend.limits();
    if (wake?.kind === 'interval' && wake.minutes < limits.minWakeMinutes) {
      return json(400, { error: `Wake must be at least ${limits.minWakeMinutes} minutes.` });
    }
    if (wake?.kind === 'cron') {
      try { checkCron(wake.cron, wake.timezone, at); checkCronWake(wake, limits.minWakeMinutes, at); } catch (error) {
        if (error instanceof ToolError) return json(400, { error: error.message });
        throw error;
      }
    }
    const saved: AssistantTask = {
      ...task, ...given(edit), ...(wake ? { wake } : {}), updatedAt: at, revision: revision + 1,
    };
    if (!(await store.putTask(saved, revision))) return CHANGED();
    return json(200, { task: saved });
  });

  app.post('/approvals/:id', async c => {
    const user = userOf(c);
    const parsed = check(decisionBody, looseBody(c.get('body')));
    if ('error' in parsed) return parsed.error;
    const id = c.req.param('id');
    const found = await store.approval(id);
    if (!found || found.owner !== user) return notFound();
    try {
      if (parsed.value.decision === 'approve') await gate.execute(id, user, parsed.value.always ?? false);
      else await gate.deny(id, user);
    } catch (error) {
      if (error instanceof ToolError) return json(409, { error: error.message });
      throw error;
    }
    const approval: ApprovalRequest | undefined = await store.approval(id);
    return approval ? json(200, { approval }) : notFound();
  });

  app.get('/connectors', async c => json(200, { connectors: await connectors.list(userOf(c)) }));

  app.put('/connectors', async c => {
    const user = userOf(c);
    const parsed = check(connectorBody, looseBody(c.get('body')));
    if ('error' in parsed) return parsed.error;
    await connectors.put(user, parsed.value);
    return json(200, { connectors: await connectors.list(user) });
  });

  app.delete('/connectors', async c => {
    const user = userOf(c);
    const parsed = check(connectorQuery, c.req.query());
    if ('error' in parsed) return parsed.error;
    await connectors.remove(user, parsed.value.name);
    return json(200, { connectors: await connectors.list(user) });
  });

  app.all('*', () => notFound());
  return app;
}
