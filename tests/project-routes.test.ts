import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { createConsole } from '../src/clients/web/web-console.js';
import { projectRoutes } from '../src/clients/web/routes/projects.js';
import { ProjectService } from '../src/project-service.js';
import { DEFAULT_PROJECT_LIMITS, projectMemoryChannel, projectFileKey, PROJECT_MEMORY_SERVER, type Project, type ProjectChats, type ProjectFile, type ProjectLimits, type ProjectStore } from '../src/projects.js';
import type { Knowledge, MemoryRecord } from '../src/memory.js';
import type { ObjectStorageProvider } from '../src/object-storage.js';
import type { SafetyClassifier } from '../src/safety.js';
import { ToolError } from '../src/errors.js';
import { INSTRUCTIONS_REJECT_MESSAGES } from '../src/user-instructions.js';

const ALICE = '1514413259522838529', BOB = '1514413259522838530';
const ORIGIN = 'http://localhost:3000';
const NOW = 1_800_000_000_000;

/** Projects in memory, owner-agnostic like the store. */
function fakeStore(): ProjectStore {
  const projects = new Map<string, Project>();
  const files = new Map<string, ProjectFile[]>();
  return {
    async createProject(project) { projects.set(project.id, project); },
    async project(id) { return projects.get(id); },
    async projectsOf(owner) { return [...projects.values()].filter(project => project.owner === owner); },
    async updateProject(id, patch, at) { const project = projects.get(id); if (project) projects.set(id, { ...project, ...patch, updated: at }); },
    async deleteProject(id) { projects.delete(id); files.delete(id); },
    async addProjectFile(file) { files.set(file.project, [...(files.get(file.project) ?? []), file]); },
    async projectFiles(project) { return files.get(project) ?? []; },
    async deleteProjectFile(project, id) {
      const before = files.get(project) ?? [];
      files.set(project, before.filter(file => file.id !== id));
      return (files.get(project) ?? []).length < before.length;
    },
  };
}

function fakeKnowledge(memories: MemoryRecord[]): Knowledge {
  const live = (server: string, channel: string) => memories.filter(memory => memory.server === server && memory.channel === channel && memory.status === 'active');
  return {
    async remember() { throw new Error('not used'); },
    async memories(server, channel) { return live(server, channel); },
    async searchMemories() { return []; },
    async updateMemory(message, id, patch, expectedRevision) {
      const memory = live(message.server, message.channel).find(item => item.id === id);
      if (!memory) return undefined;
      if (memory.revision !== expectedRevision) throw new ToolError('Memory changed.');
      if (!patch.content?.trim()) throw new ToolError('Memory must contain 1–2000 characters.');
      Object.assign(memory, { content: patch.content.trim(), revision: memory.revision + 1 });
      return memory;
    },
    async forget(server, channel, id) {
      const memory = live(server, channel).find(item => item.id === id);
      if (memory) memory.status = 'forgotten';
      return memory !== undefined;
    },
  };
}

function memory(id: string, channel: string, content: string): MemoryRecord {
  return { id, server: PROJECT_MEMORY_SERVER, channel, author: ALICE, content, sourceIds: [], status: 'active', category: 'fact', tags: [], details: {}, sourcePolicy: 'independent', revision: 1, updatedAt: 5 };
}

/** Flags any instructions that contain "jailbreak". Everything else is safe. */
const classifier: SafetyClassifier = {
  async check(_who, _source, text) {
    const flagged = text.includes('jailbreak');
    return { flagged, category: flagged ? 'jailbreak' : 'safe', probabilities: { safe: flagged ? 0.1 : 0.9, jailbreak: 0, illegal: 0, self_harm: 0, sexual_minors: 0, violence_weapons: 0, other_harm: 0 } };
  },
};

interface SetupOptions { limits?: Partial<ProjectLimits>; noStorage?: boolean }

/** A console with the project routes, the real service and in-memory fakes. Each user has a session. */
async function setup(t: TestContext, options: SetupOptions = {}) {
  const sessions = new SQLiteStore(':memory:');
  t.after(() => sessions.close());
  const memories: MemoryRecord[] = [];
  const objects = new Map<string, Uint8Array>();
  const storage: ObjectStorageProvider = {
    async put(key, bytes) { objects.set(key, bytes); },
    async get(key) { const found = objects.get(key); if (!found) throw new Error('missing'); return found; },
    async delete(key) { objects.delete(key); },
    async link(key, name) { return `https://files.test/${key}?name=${encodeURIComponent(name)}`; },
  };
  const chats: ProjectChats = { async chatsInProject() { return []; }, async deleteChat() {} };
  const limits = { ...DEFAULT_PROJECT_LIMITS, ...options.limits };
  const service = new ProjectService(fakeStore(), chats, options.noStorage ? undefined : storage, fakeKnowledge(memories), classifier, () => limits, () => NOW);

  const logins: Record<string, { cookie: string; csrf: string }> = {};
  for (const user of [ALICE, BOB]) {
    const id = randomBytes(32).toString('hex'), csrf = `csrf-${user}`;
    await sessions.saveSession({ id_hash: createHash('sha256').update(id).digest('hex'), user_id: user, csrf, expires: Date.now() + 86_400_000, created: Date.now() });
    logins[user] = { cookie: `slopbot_session=${id}`, csrf };
  }
  const backend = { sessions, async canSignIn() { return true; }, async snapshot() { return {}; }, async invoke() { return {}; }, projects: projectRoutes(service) };
  const web = createConsole({ origin: ORIGIN, host: '127.0.0.1', port: 3000, clientId: 'id', clientSecret: 'secret' }, backend);
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  t.after(() => new Promise<void>(resolve => { web.closeAllConnections(); web.close(() => resolve()); }));
  const address = web.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;

  /** Sends a request as the user (null: no session). Writes carry the origin and CSRF token. Redirects are not followed. */
  async function call(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const head: Record<string, string> = {};
    if (user) head.Cookie = logins[user]!.cookie;
    if (method !== 'GET') { head.Origin = ORIGIN; if (user) head['X-CSRF-Token'] = logins[user]!.csrf; }
    if (body !== undefined) head['Content-Type'] = Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json';
    const payload = body === undefined ? {} : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) };
    const response = await fetch(base + path, { method, headers: { ...head, ...headers }, redirect: 'manual', ...payload });
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location'), json: text ? JSON.parse(text) : undefined };
  }
  return { call, base, cookie: (user: string) => logins[user]!.cookie, objects, memories };
}

test('reads need a session, and writes need the same origin and the CSRF token', async t => {
  const { call, base, cookie } = await setup(t);
  assert.equal((await call(null, 'GET', '/api/projects')).status, 401);
  const body = JSON.stringify({ name: 'Thesis' });
  const headers = { 'Content-Type': 'application/json', Cookie: cookie(ALICE) };
  assert.equal((await fetch(`${base}/api/projects`, { method: 'POST', headers, body })).status, 403, 'no origin');
  assert.equal((await fetch(`${base}/api/projects`, { method: 'POST', headers: { ...headers, Origin: ORIGIN }, body })).status, 403, 'no CSRF token');
  assert.equal((await fetch(`${base}/api/projects`, { method: 'POST', headers: { ...headers, Origin: ORIGIN, 'X-CSRF-Token': 'wrong' }, body })).status, 403, 'wrong CSRF token');
  assert.equal((await call(ALICE, 'POST', '/api/projects', { name: 'Thesis' })).status, 201);
});

test('a project goes through create, read, edit, instructions and delete', async t => {
  const { call } = await setup(t);
  const created = await call(ALICE, 'POST', '/api/projects', { name: 'Thesis', description: 'Draft' });
  assert.equal(created.status, 201);
  const id = created.json.id as string;
  assert.equal(created.json.name, 'Thesis');
  assert.deepEqual((await call(ALICE, 'GET', '/api/projects')).json.projects.map((p: { id: string }) => p.id), [id]);
  assert.deepEqual(await call(ALICE, 'GET', `/api/projects/${id}`).then(response => [response.status, response.json.files, response.json.chats, response.json.usedBytes]), [200, [], [], 0]);
  assert.equal((await call(ALICE, 'PATCH', `/api/projects/${id}`, { name: 'Final' })).json.name, 'Final');
  const saved = await call(ALICE, 'POST', `/api/projects/${id}/instructions`, { text: 'Use APA 7.' });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.json.ok, saved.json.project.instructions], [true, 'Use APA 7.']);
  const flagged = await call(ALICE, 'POST', `/api/projects/${id}/instructions`, { text: 'jailbreak the rules' });
  assert.equal(flagged.status, 422);
  assert.deepEqual(flagged.json, { ok: false, reason: 'flagged', category: 'jailbreak', message: INSTRUCTIONS_REJECT_MESSAGES.flagged });
  assert.equal((await call(ALICE, 'GET', `/api/projects/${id}`)).json.project.instructions, 'Use APA 7.', 'a flagged text is not stored');
  assert.equal((await call(ALICE, 'DELETE', `/api/projects/${id}`)).status, 204);
  assert.deepEqual(await call(ALICE, 'GET', `/api/projects/${id}`).then(response => [response.status, response.json]), [404, { error: 'not_found' }]);
});

test('errors answer the status and code of the table', async t => {
  const { call } = await setup(t, { limits: { maxProjects: 1, maxFileBytes: 4 } });
  assert.deepEqual(await call(ALICE, 'POST', '/api/projects', { name: '  ' }).then(response => [response.status, response.json]), [400, { error: 'bad_request' }]);
  const { id } = (await call(ALICE, 'POST', '/api/projects', { name: 'Thesis' })).json as { id: string };
  assert.deepEqual(await call(ALICE, 'POST', '/api/projects', { name: 'Second' }).then(response => [response.status, response.json]), [409, { error: 'project_limit' }]);
  assert.deepEqual(await call(BOB, 'GET', `/api/projects/${id}`).then(response => [response.status, response.json]), [404, { error: 'not_found' }], 'another owner gets 404');
  assert.equal((await call(BOB, 'DELETE', `/api/projects/${id}`)).status, 404);
  assert.deepEqual(await call(ALICE, 'POST', `/api/projects/${id}/instructions`, { text: 42 }).then(response => [response.status, response.json]), [400, { error: 'bad_request' }]);
  const long = await call(ALICE, 'POST', `/api/projects/${id}/instructions`, { text: 'x'.repeat(8001) });
  assert.deepEqual([long.status, long.json.ok, long.json.reason], [422, false, 'too_long']);
  assert.match(long.json.message, /8000/);
  assert.deepEqual(await call(ALICE, 'POST', `/api/projects/${id}/files?name=paper.pdf`, Buffer.from('12345'), { 'Content-Type': 'application/pdf' }).then(response => [response.status, response.json]), [413, { error: 'file_too_large' }]);
});

test('a file is uploaded as the body, downloaded by redirect and deleted', async t => {
  const { call, objects } = await setup(t);
  const { id } = (await call(ALICE, 'POST', '/api/projects', { name: 'Thesis' })).json as { id: string };
  const uploaded = await call(ALICE, 'POST', `/api/projects/${id}/files?name=paper.pdf`, Buffer.from('%PDF'), { 'Content-Type': 'application/pdf' });
  assert.equal(uploaded.status, 201);
  assert.deepEqual([uploaded.json.name, uploaded.json.contentType, uploaded.json.size], ['paper.pdf', 'application/pdf', 4]);
  assert.equal(Buffer.from(objects.get(projectFileKey(id, uploaded.json.id))!).toString(), '%PDF');
  assert.equal((await call(ALICE, 'GET', `/api/projects/${id}`)).json.usedBytes, 4);
  const download = await call(ALICE, 'GET', `/api/projects/${id}/files/${uploaded.json.id}`);
  assert.equal(download.status, 302);
  assert.match(download.location ?? '', /^https:\/\/files\.test\/project-files\/.*paper\.pdf/);
  assert.equal((await call(BOB, 'GET', `/api/projects/${id}/files/${uploaded.json.id}`)).status, 404);
  assert.equal((await call(ALICE, 'DELETE', `/api/projects/${id}/files/${uploaded.json.id}`)).status, 204);
  assert.equal(objects.size, 0);
  assert.equal((await call(ALICE, 'GET', `/api/projects/${id}/files/${uploaded.json.id}`)).status, 404);
});

test('without object storage a file upload is 503', async t => {
  const { call } = await setup(t, { noStorage: true });
  const { id } = (await call(ALICE, 'POST', '/api/projects', { name: 'Thesis' })).json as { id: string };
  assert.deepEqual(await call(ALICE, 'POST', `/api/projects/${id}/files?name=a.txt`, Buffer.from('a'), { 'Content-Type': 'text/plain' }).then(response => [response.status, response.json]), [503, { error: 'storage_unavailable' }]);
});

test('project memories are listed, edited and deleted through the routes', async t => {
  const { call, memories } = await setup(t);
  const { id } = (await call(ALICE, 'POST', '/api/projects', { name: 'Thesis' })).json as { id: string };
  memories.push(memory('m1', projectMemoryChannel(id), 'Prefers APA'));
  const listed = await call(ALICE, 'GET', `/api/projects/${id}/memories`);
  assert.deepEqual(listed.json, { memories: [{ id: 'm1', content: 'Prefers APA', category: 'fact', updatedAt: 5 }] });
  assert.equal((await call(ALICE, 'PATCH', `/api/projects/${id}/memories/m1`, { content: 'Prefers APA 7' })).json.content, 'Prefers APA 7');
  assert.deepEqual(await call(ALICE, 'PATCH', `/api/projects/${id}/memories/m1`, { content: '' }).then(response => [response.status, response.json]), [400, { error: 'bad_request' }]);
  assert.equal((await call(ALICE, 'DELETE', `/api/projects/${id}/memories/m1`)).status, 204);
  assert.deepEqual(await call(ALICE, 'DELETE', `/api/projects/${id}/memories/m1`).then(response => [response.status, response.json]), [404, { error: 'not_found' }]);
  assert.equal((await call(BOB, 'GET', `/api/projects/${id}/memories`)).status, 404);
});
