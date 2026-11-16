import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { PostgresStore } from '../src/adapters/postgres.js';
import { PROJECT_MEMORY_SERVER } from '../src/projects.js';
import { ToolRegistry, ToolError } from '../src/tools.js';
import { configuredChannels, registerServerTools } from '../src/server-tools.js';
import { loadConfig } from '../src/config.js';
import { HistoryImporter } from '../src/history.js';
import type { Message } from '../src/domain.js';
import type { ParticipationOptions } from '../src/participation.js';

const configServer = '12345678901234567';
const config = loadConfig({ DISCORD_BOT_TOKEN: 'test', DISCORD_GUILD_ID: configServer, DISCORD_CHANNEL_IDS: '12345678901234568', LLM_MODE: 'mock' });
const project = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', projectScope = { server: PROJECT_MEMORY_SERVER, channel: `project:${project}` };
// Text about the launch embeds near "rocket": a semantic match finds a memory that shares no word with the query.
const embeddings = { model: 'project-memory-test', async embed(text: string) { return /launch|rocket|lunar/i.test(text) ? [1, 0] : [0, 1]; } };
const chatA: Message = { server: 'project-server-a', channel: 'chat-a', author: 'alice', id: 'a-1', text: 'the launch is on friday', project };
const chatB: Message = { server: 'project-server-b', channel: 'chat-b', author: 'alice', id: 'b-1', text: 'when is the launch?', project };
const plain: Message = { server: 'plain-server', channel: 'plain-chat', author: 'alice', id: 'p-1', text: 'plain statement' };

for (const backend of ['sqlite', 'postgres'] as const) {
  const skip = backend === 'postgres' && !process.env.TEST_DATABASE_URL;
  async function open(t: { after(fn: () => unknown): void }, schema: string): Promise<SQLiteStore | PostgresStore> {
    const store = backend === 'sqlite' ? new SQLiteStore(':memory:', embeddings) : await PostgresStore.connect(process.env.TEST_DATABASE_URL!, embeddings, schema);
    t.after(async () => {
      await store.finishIndexing(); await store.close();
      if (backend === 'postgres') { const cleanup = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await cleanup.connect(); await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); await cleanup.end(); }
    });
    return store;
  }

  test(`${backend}: a memory saved in a project chat is found from another chat of the project on another server`, { skip }, async t => {
    const store = await open(t, 'slopbot_test_project_memory_shared');
    await store.ingest(chatA); await store.ingest(chatB);
    const note = await store.remember(chatA, 'The launch is on Friday');
    assert.equal(note.server, PROJECT_MEMORY_SERVER); assert.equal(note.channel, 'project:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.deepEqual((await store.memories(projectScope.server, projectScope.channel)).map(item => item.id), [note.id]);
    assert.deepEqual(await store.memories(chatA.server, chatA.channel), []);
    assert.equal((await store.searchMemories(chatB, { query: 'launch' }))[0]?.id, note.id);
    assert.ok((await store.retrieve(chatB, 8)).some(item => item.kind === 'memory' && item.memoryId === note.id));
  });

  test(`${backend}: project memories are embedded in the project scope and found by meaning from another chat`, { skip }, async t => {
    const store = await open(t, 'slopbot_test_project_memory_embedding');
    await store.ingest(chatA); await store.ingest(chatB);
    const note = await store.remember(chatA, 'Lunar payload ships friday', { sourcePolicy: 'independent' });
    await store.finishIndexing();
    assert.equal((await store.searchMemories(chatB, { query: 'rocket' }))[0]?.id, note.id);
  });

  test(`${backend}: a source-bound project memory stays visible until its source chat message is deleted`, { skip }, async t => {
    const store = await open(t, 'slopbot_test_project_memory_source');
    await store.ingest(chatA); await store.ingest(chatB);
    const note = await store.remember(chatA, 'The launch is on Friday');
    assert.equal(note.sourcePolicy, 'source_bound'); assert.deepEqual(note.sourceIds, [chatA.id]);
    assert.equal((await store.searchMemories(chatB, { query: 'launch' })).length, 1);
    await store.remove(chatA.server, chatA.channel, chatA.id);
    assert.equal((await store.searchMemories(chatB, { query: 'launch' })).length, 0);
    assert.deepEqual(await store.memories(projectScope.server, projectScope.channel), []);
  });

  test(`${backend}: a chat without a project keeps its own memories and never sees project memories`, { skip }, async t => {
    const store = await open(t, 'slopbot_test_project_memory_plain');
    await store.ingest(chatA); await store.ingest(plain);
    const projectNote = await store.remember(chatA, 'The launch is on Friday', { sourcePolicy: 'independent' });
    const plainNote = await store.remember(plain, 'plain statement', { sourcePolicy: 'independent' });
    assert.deepEqual((await store.memories(plain.server, plain.channel)).map(item => item.id), [plainNote.id]);
    assert.equal((await store.searchMemories(plain, { query: 'launch' })).length, 0);
    assert.equal((await store.searchMemories(plain, { query: 'plain' }))[0]?.id, plainNote.id);
    assert.equal(await store.updateMemory(plain, projectNote.id, { content: 'changed' }, 1), undefined);
    assert.equal(await store.forget(plain.server, plain.channel, projectNote.id, 'alice'), false);
    assert.deepEqual((await store.memories(projectScope.server, projectScope.channel)).map(item => item.id), [projectNote.id]);
  });

  test(`${backend}: a project memory can be updated and forgotten through the project scope from any chat of the project`, { skip }, async t => {
    const store = await open(t, 'slopbot_test_project_memory_forget');
    await store.ingest(chatA); await store.ingest(chatB);
    const note = await store.remember(chatA, 'The launch is on Friday', { sourcePolicy: 'independent' });
    const updated = await store.updateMemory(chatB, note.id, { content: 'The launch moved to monday' }, 1);
    assert.equal(updated?.revision, 2); assert.equal(updated?.server, PROJECT_MEMORY_SERVER);
    assert.equal(await store.forget(chatB.server, chatB.channel, note.id, 'alice'), false);
    assert.equal(await store.forget(projectScope.server, projectScope.channel, note.id, 'alice'), true);
    assert.equal((await store.searchMemories(chatB, { query: 'monday' })).length, 0);
  });
}

test('memory tools in a project chat store independent memories by default and forget them from another chat', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.store.ingest(chatA);
  const saved = await f.registry.invokeResult(chatA, 'memory_remember', { text: 'The launch is on Friday' }, 'remember-default', 'agent');
  const note = saved.data as { id: string; server: string; channel: string; sourcePolicy: string; sourceIds: string[] };
  assert.equal(note.sourcePolicy, 'independent'); assert.deepEqual(note.sourceIds, []);
  assert.equal(note.server, PROJECT_MEMORY_SERVER); assert.equal(note.channel, 'project:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const bound = await f.registry.invokeResult(chatA, 'memory_remember', { text: 'The launch is at noon', source_policy: 'source_bound' }, 'remember-bound', 'agent');
  assert.deepEqual((bound.data as { sourceIds: string[] }).sourceIds, [chatA.id]);
  const found = await f.registry.invokeResult(chatB, 'memory', { query: 'launch' }, 'find-from-b', 'agent');
  assert.match(found.text, /The launch is on Friday/);
  await f.registry.invokeResult(chatB, 'memory_forget', { id: note.id }, 'forget-from-b', 'agent');
  assert.equal((await f.store.memories(projectScope.server, projectScope.channel)).length, 1);
});

function setup() {
  const store = new SQLiteStore();
  let channels = configuredChannels(config, store, configServer);
  const history = new HistoryImporter(configServer, store, { async fetch() { return []; } });
  const registry = new ToolRegistry(store, async () => true);
  const participation = { options: { enabled: true, contextMessages: 8, cooldownMs: 60000, maxUnsolicitedPerHour: 3 } as ParticipationOptions, diagnostics: new Map<string, string>() };
  registerServerTools(registry, { config, server: configServer, store, participation, history, channels: () => channels,
    setChannels(value) { channels = value; }, async validateChannel(_message, id) { if (!channels.includes(id)) throw new ToolError('Cannot view channel'); },
    async findChannels() { return ''; },
    accepts: id => channels.includes(id), setReplyContext() {}, originMessage: value => value,
    async startTask() { return ''; }, async reconcileTask() { return undefined; }, wakeWorker() {}, async isTeamEditor() { return false; },
  });
  return { store, registry };
}
