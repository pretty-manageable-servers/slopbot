import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { createConsole } from '../src/clients/web/web-console.js';
import type { AssistantBackend } from '../src/clients/web/routes/assistant.js';
import type { AssistantStore } from '../src/assistant/store.js';
import { DEFAULT_ASSISTANT_LIMITS, assistantHomeChannel, type ActivityItem, type ApprovalRequest, type AssistantSettings, type AssistantTask } from '../src/assistant/types.js';
import { ToolError } from '../src/errors.js';

const ALICE = '1514413259522838529', BOB = '1514413259522838530';
const ORIGIN = 'http://localhost:3000';
const NOW = Date.UTC(2026, 10, 27, 12, 0);

function task(id: string, owner: string, patch: Partial<AssistantTask> = {}): AssistantTask {
  return {
    id, owner, goal: 'Watch the build', instructions: 'Check CI', status: 'active', pause: null,
    wake: { kind: 'interval', minutes: 120 }, nextAt: NOW + 60_000, rules: {}, effort: 'low', failures: 0,
    lastRunAt: null, lastError: null, createdAt: NOW, updatedAt: NOW, revision: 1, ...patch,
  };
}

function approval(id: string, owner: string, status: ApprovalRequest['status'] = 'pending'): ApprovalRequest {
  return {
    id, owner, task: null, run: 'run-1', tool: 'github_comment', input: {}, summary: 'Comment on PR 4',
    status, result: null, createdAt: NOW, decidedAt: null, expiresAt: NOW + 3_600_000,
  };
}

function item(id: string, owner: string, createdAt: number): ActivityItem {
  return { id, owner, task: null, kind: 'update', text: `Update ${id}`, ref: null, createdAt, readAt: null };
}

/** An in-memory store. Tasks use the CAS the routes rely on. Methods the routes never call throw. */
function fakeStore(seed: { tasks?: AssistantTask[]; approvals?: ApprovalRequest[]; activity?: ActivityItem[] } = {}) {
  const tasks = new Map((seed.tasks ?? []).map(t => [t.id, t]));
  const approvals = new Map((seed.approvals ?? []).map(a => [a.id, a]));
  const activity = seed.activity ?? [];
  const settings = new Map<string, AssistantSettings>();
  const briefNext = new Map<string, number | null>();
  const unused = async (): Promise<never> => { throw new Error('not used'); };
  const store: AssistantStore = {
    async settings(user) { return settings.get(user); },
    async putSettings(s) { settings.set(s.user, s); },
    async tasks(owner) { return [...tasks.values()].filter(t => t.owner === owner); },
    async task(id) { return tasks.get(id); },
    async putTask(t, expected) {
      if ((tasks.get(t.id)?.revision ?? null) !== expected) return false;
      tasks.set(t.id, t);
      return true;
    },
    dueTasks: unused, dueBriefs: unused, addTrigger: unused, takeTriggers: unused, addApproval: unused, decideApproval: unused, setApprovalResult: unused, addActivity: unused,
    async setBriefNextAt(user, at) { briefNext.set(user, at); },
    async approval(id) { return approvals.get(id); },
    async pendingApprovals(owner) { return [...approvals.values()].filter(a => a.owner === owner && a.status === 'pending'); },
    async activity(owner, before, limit) {
      return activity.filter(a => a.owner === owner && (before === null || a.createdAt < before))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
    async markRead(owner, ids, now) {
      for (const a of activity) if (a.owner === owner && ids.includes(a.id)) a.readAt = now;
    },
  };
  return { store, tasks, approvals, activity, briefNext };
}

/** A gate that decides like the real one: only a pending approval can be decided, otherwise it throws a ToolError. */
function fakeGate(approvals: Map<string, ApprovalRequest>): AssistantBackend['gate'] {
  const decide = (id: string, status: ApprovalRequest['status']) => {
    const found = approvals.get(id);
    if (!found || found.status !== 'pending') throw new ToolError('This approval was already decided.');
    found.status = status;
    found.decidedAt = NOW;
  };
  return {
    async execute(id) {
      decide(id, 'approved');
      if (id === 'boom') {
        Object.assign(approvals.get(id)!, { status: 'failed', result: 'Tool exploded' });
        throw new ToolError('Tool exploded');
      }
    },
    async deny(id) { decide(id, 'denied'); },
  };
}

/** Connectors per user, keyed by user ID. */
function fakeConnectors(seed: Record<string, { name: string; url: string }[]> = {}): AssistantBackend['connectors'] {
  const byUser = new Map(Object.entries(seed));
  return {
    async list(user) { return byUser.get(user) ?? []; },
    async put(user, body) {
      byUser.set(user, [...(byUser.get(user) ?? []).filter(c => c.name !== body.name), { name: body.name, url: body.url }]);
    },
    async remove(user, name) { byUser.set(user, (byUser.get(user) ?? []).filter(c => c.name !== name)); },
  };
}

/** A console with the assistant routes over the fakes. Each user has a session. */
async function setup(t: TestContext, seed: Parameters<typeof fakeStore>[0] = {}, limits = DEFAULT_ASSISTANT_LIMITS, connectors: Record<string, { name: string; url: string }[]> = {}) {
  const sessions = new SQLiteStore(':memory:');
  t.after(() => sessions.close());
  const logins: Record<string, { cookie: string; csrf: string }> = {};
  for (const user of [ALICE, BOB]) {
    const id = randomBytes(32).toString('hex'), csrf = `csrf-${user}`;
    await sessions.saveSession({ id_hash: createHash('sha256').update(id).digest('hex'), user_id: user, csrf, expires: Date.now() + 86_400_000, created: Date.now() });
    logins[user] = { cookie: `slopbot_session=${id}`, csrf };
  }
  const fake = fakeStore(seed);
  const homeChats: string[] = [];
  const assistant: AssistantBackend = {
    store: fake.store,
    gate: fakeGate(fake.approvals),
    connectors: fakeConnectors(connectors),
    async limits() { return limits; },
    async ensureHomeChat(user) { homeChats.push(user); },
    now: () => NOW,
  };
  const backend = { sessions, async canSignIn() { return true; }, async snapshot() { return {}; }, async invoke() { return {}; }, assistant };
  const web = createConsole({ origin: ORIGIN, host: '127.0.0.1', port: 3000, clientId: 'id', clientSecret: 'secret' }, backend);
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  t.after(() => new Promise<void>(resolve => { web.closeAllConnections(); web.close(() => resolve()); }));
  const address = web.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;

  /** Sends a request as the user (null: no session). Writes carry the origin and CSRF token. */
  async function call(user: string | null, method: string, path: string, body?: unknown) {
    const head: Record<string, string> = {};
    if (user) head.Cookie = logins[user]!.cookie;
    if (method !== 'GET') { head.Origin = ORIGIN; if (user) head['X-CSRF-Token'] = logins[user]!.csrf; }
    if (body !== undefined) head['Content-Type'] = 'application/json';
    const response = await fetch(base + path, { method, headers: head, body: body === undefined ? null : JSON.stringify(body), redirect: 'manual' });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  }
  return { call, base, cookie: (user: string) => logins[user]!.cookie, csrf: (user: string) => logins[user]!.csrf, homeChats, ...fake };
}

test('every route needs a session', async t => {
  const { call } = await setup(t);
  assert.equal((await call(null, 'GET', '/api/assistant')).status, 401);
  assert.equal((await call(null, 'PUT', '/api/assistant/settings', { enabled: true })).status, 401);
});

test('a write without the CSRF token is refused', async t => {
  const { base, cookie } = await setup(t);
  const response = await fetch(base + '/api/assistant/settings', {
    method: 'PUT', redirect: 'manual',
    headers: { Cookie: cookie(ALICE), Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(response.status, 403);
});

test('GET returns the signed-in user settings, sprouts, pending approvals and unread count', async t => {
  const { call, homeChats } = await setup(t, {
    tasks: [task('t1', ALICE), task('t2', BOB)],
    approvals: [approval('a1', ALICE), approval('a2', BOB)],
    activity: [item('x1', ALICE, NOW - 2), { ...item('x2', ALICE, NOW - 1), readAt: NOW - 1 }],
  });
  const response = await call(ALICE, 'GET', '/api/assistant');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.settings, { user: ALICE, enabled: false, briefCron: null, timezone: 'UTC', dmUpdates: true, quietStart: null, quietEnd: null, updated: 0 });
  assert.deepEqual(response.json.tasks.map((x: AssistantTask) => x.id), ['t1']);
  assert.deepEqual(response.json.pending.map((x: ApprovalRequest) => x.id), ['a1']);
  assert.equal(response.json.unread, 1);
  assert.equal(response.json.homeChat, assistantHomeChannel(ALICE));
  assert.deepEqual(homeChats, [ALICE]);
});

test('PUT settings saves the fields it sets, keeps the owner, and sets the next brief time', async t => {
  const { call, briefNext } = await setup(t);
  const response = await call(ALICE, 'PUT', '/api/assistant/settings', { enabled: true, briefCron: '0 9 * * *', timezone: 'Europe/London', user: BOB, updated: 1 });
  assert.equal(response.status, 200);
  assert.equal(response.json.settings.user, ALICE);
  assert.equal(response.json.settings.enabled, true);
  assert.equal(response.json.settings.updated, NOW);
  assert.equal(briefNext.get(ALICE), Date.UTC(2026, 10, 28, 9, 0));
});

test('PUT settings with an invalid cron is 400', async t => {
  const { call } = await setup(t);
  const response = await call(ALICE, 'PUT', '/api/assistant/settings', { briefCron: 'every morning' });
  assert.equal(response.status, 400);
});

test('PUT settings with an invalid timezone is 400', async t => {
  const { call } = await setup(t);
  const response = await call(ALICE, 'PUT', '/api/assistant/settings', { timezone: 'Mars/Olympus' });
  assert.equal(response.status, 400);
});

test('GET activity returns the newest items up to the limit, and a limit over 50 is 400', async t => {
  const { call } = await setup(t, { activity: [item('x1', ALICE, NOW - 3), item('x2', ALICE, NOW - 2), item('x3', ALICE, NOW - 1), item('x4', BOB, NOW)] });
  const page = await call(ALICE, 'GET', '/api/assistant/activity?limit=2');
  assert.equal(page.status, 200);
  assert.deepEqual(page.json.items.map((x: ActivityItem) => x.id), ['x3', 'x2']);
  assert.equal((await call(ALICE, 'GET', '/api/assistant/activity?limit=51')).status, 400);
});

test('POST activity/read marks the given items read for the signed-in user only', async t => {
  const { call, activity } = await setup(t, { activity: [item('x1', ALICE, NOW - 1), item('x2', BOB, NOW - 1)] });
  const response = await call(ALICE, 'POST', '/api/assistant/activity/read', { ids: ['x1', 'x2'] });
  assert.deepEqual(response.json, { ok: true });
  assert.deepEqual(activity.map(x => x.readAt), [NOW, null]);
});

test('POST tasks/:id approve turns a proposed sprout active and runs it now', async t => {
  const { call, tasks } = await setup(t, { tasks: [task('t1', ALICE, { status: 'proposed', nextAt: null })] });
  const response = await call(ALICE, 'POST', '/api/assistant/tasks/t1', { action: 'approve' });
  assert.equal(response.status, 200);
  assert.equal(response.json.task.status, 'active');
  assert.equal(response.json.task.nextAt, NOW);
  assert.equal(response.json.task.revision, 2);
  assert.equal(tasks.get('t1')?.status, 'active');
});

test('POST tasks/:id pause then resume clears the pause and the failures', async t => {
  const { call } = await setup(t, { tasks: [task('t1', ALICE, { failures: 2 })] });
  const paused = await call(ALICE, 'POST', '/api/assistant/tasks/t1', { action: 'pause' });
  assert.equal(paused.json.task.status, 'paused');
  assert.equal(paused.json.task.pause, 'owner');
  const resumed = await call(ALICE, 'POST', '/api/assistant/tasks/t1', { action: 'resume' });
  assert.equal(resumed.json.task.status, 'active');
  assert.equal(resumed.json.task.pause, null);
  assert.equal(resumed.json.task.failures, 0);
});

test('POST tasks/:id with an action that does not apply to the status is 409', async t => {
  const { call } = await setup(t, { tasks: [task('t1', ALICE)] });
  assert.equal((await call(ALICE, 'POST', '/api/assistant/tasks/t1', { action: 'decline' })).status, 409);
});

test("another user's sprout is 404", async t => {
  const { call, tasks } = await setup(t, { tasks: [task('t2', BOB, { status: 'proposed', nextAt: null })] });
  assert.equal((await call(ALICE, 'POST', '/api/assistant/tasks/t2', { action: 'approve' })).status, 404);
  assert.equal((await call(ALICE, 'PATCH', '/api/assistant/tasks/t2', { goal: 'Mine now', revision: 1 })).status, 404);
  assert.equal(tasks.get('t2')?.status, 'proposed');
});

test('approving past the active limit is 422', async t => {
  const active = [1, 2, 3, 4, 5].map(n => task(`a${n}`, ALICE));
  const { call } = await setup(t, { tasks: [...active, task('p1', ALICE, { status: 'proposed', nextAt: null })] });
  const response = await call(ALICE, 'POST', '/api/assistant/tasks/p1', { action: 'approve' });
  assert.equal(response.status, 422);
  assert.equal(response.json.error, 'Limit reached: 5 active sprouts.');
});

test('PATCH tasks/:id saves the edit with the next revision', async t => {
  const { call, tasks } = await setup(t, { tasks: [task('t1', ALICE)] });
  const response = await call(ALICE, 'PATCH', '/api/assistant/tasks/t1', {
    goal: 'Watch the release', rules: { github_comment: 'ask' }, effort: 'xhigh', wake: { kind: 'interval', minutes: 240 }, revision: 1,
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.task.goal, 'Watch the release');
  assert.deepEqual(response.json.task.rules, { github_comment: 'ask' });
  assert.deepEqual(response.json.task.wake, { kind: 'interval', minutes: 240 });
  assert.equal(response.json.task.revision, 2);
  assert.equal(tasks.get('t1')?.goal, 'Watch the release');
});

test('PATCH tasks/:id with a stale revision is 409', async t => {
  const { call } = await setup(t, { tasks: [task('t1', ALICE)] });
  const response = await call(ALICE, 'PATCH', '/api/assistant/tasks/t1', { goal: 'Late edit', revision: 0 });
  assert.equal(response.status, 409);
  assert.equal(response.json.error, 'Changed. Reload.');
});

test('PATCH tasks/:id with a wake under the minimum is 400', async t => {
  const { call } = await setup(t, { tasks: [task('t1', ALICE)] });
  const response = await call(ALICE, 'PATCH', '/api/assistant/tasks/t1', { wake: { kind: 'interval', minutes: 30 }, revision: 1 });
  assert.equal(response.status, 400);
});

test('POST approvals/:id approve runs the gate and returns the approval as decided', async t => {
  const { call } = await setup(t, { approvals: [approval('a1', ALICE)] });
  const response = await call(ALICE, 'POST', '/api/assistant/approvals/a1', { decision: 'approve', always: true });
  assert.equal(response.status, 200);
  assert.equal(response.json.approval.status, 'approved');
});

test('POST approvals/:id approve whose tool failed is 200 with the failed approval and its error', async t => {
  const { call } = await setup(t, { approvals: [approval('boom', ALICE)] });
  const response = await call(ALICE, 'POST', '/api/assistant/approvals/boom', { decision: 'approve' });
  assert.equal(response.status, 200);
  assert.equal(response.json.approval.status, 'failed');
  assert.equal(response.json.approval.result, 'Tool exploded');
});

test('POST approvals/:id on a decided approval is 409 with the gate message', async t => {
  const { call } = await setup(t, { approvals: [approval('a1', ALICE, 'expired')] });
  const response = await call(ALICE, 'POST', '/api/assistant/approvals/a1', { decision: 'deny' });
  assert.equal(response.status, 409);
  assert.equal(response.json.error, 'This approval was already decided.');
});

test("another user's approval is 404", async t => {
  const { call } = await setup(t, { approvals: [approval('a2', BOB)] });
  assert.equal((await call(ALICE, 'POST', '/api/assistant/approvals/a2', { decision: 'deny' })).status, 404);
});

test('GET connectors lists the signed-in user connectors', async t => {
  const { call } = await setup(t, {}, DEFAULT_ASSISTANT_LIMITS, { [ALICE]: [{ name: 'github', url: 'https://github.example' }] });
  const response = await call(ALICE, 'GET', '/api/assistant/connectors');
  assert.deepEqual(response.json, { connectors: [{ name: 'github', url: 'https://github.example' }] });
});

test('PUT connectors adds a connector and answers with the list', async t => {
  const { call } = await setup(t);
  const response = await call(ALICE, 'PUT', '/api/assistant/connectors', { name: 'docs', url: 'https://docs.example', token: 'secret' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { connectors: [{ name: 'docs', url: 'https://docs.example' }] });
});

test('DELETE connectors removes the named connector', async t => {
  const { call } = await setup(t, {}, DEFAULT_ASSISTANT_LIMITS, { [ALICE]: [{ name: 'docs', url: 'https://docs.example' }, { name: 'github', url: 'https://github.example' }] });
  const response = await call(ALICE, 'DELETE', '/api/assistant/connectors?name=docs');
  assert.deepEqual(response.json, { connectors: [{ name: 'github', url: 'https://github.example' }] });
});
