import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { Client } from 'pg';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { PostgresStore } from '../src/adapters/postgres.js';
import type { Message } from '../src/domain.js';
import { PERSONAL_SERVER, incognitoChannel } from '../src/personal.js';
import { directMessageChannel, privateChannel } from '../src/private-chat.js';
import { PROJECT_MEMORY_SERVER, newProjectId, projectMemoryChannel, type ProjectStore } from '../src/projects.js';
import { ToolRegistry } from '../src/tools.js';
import { registerServerTools } from '../src/server-tools.js';
import { loadConfig } from '../src/config.js';
import { HistoryImporter } from '../src/history.js';
import type { ParticipationOptions } from '../src/participation.js';

const server = 'user-memory';
const guild = '100000000000000002';
const chatA = privateChannel('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const chatB = privateChannel('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const dm = directMessageChannel('100000000000000001');
const incognito = incognitoChannel('cccccccccccccccccccccccccccccccc');

function message(id: string, channel: string, author: string, text: string, extra: Partial<Message> = {}): Message {
  return { id, server, channel, author, text, timestamp: 1_000, ...extra };
}

async function openStore(backend: 'sqlite' | 'postgres', name: string, t: TestContext) {
  const schema = `slopbot_test_${name}`;
  const store = backend === 'sqlite' ? new SQLiteStore(':memory:') : await PostgresStore.connect(process.env.TEST_DATABASE_URL!, undefined, schema);
  t.after(async () => {
    await store.close();
    if (backend === 'postgres') { const cleanup = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await cleanup.connect(); await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); await cleanup.end(); }
  });
  return store;
}

async function createProject(store: ProjectStore, owner: string): Promise<string> {
  const id = newProjectId();
  await store.createProject({ id, owner, name: 'Thesis', description: '', instructions: '', instructionsUpdated: null, created: 1, updated: 1 });
  return id;
}

for (const backend of ['sqlite', 'postgres'] as const) {
  const skip = backend === 'postgres' && !process.env.TEST_DATABASE_URL;

  test(`${backend}: web chat and DM memories share the personal scope, and web chats do not search history`, { skip }, async t => {
    const store = await openStore(backend, 'user_memory_personal', t);
    const source = message('a-1', chatA, 'alice', 'The summer trip is in June');
    await store.ingest(source);
    const note = await store.remember(source, 'Alice plans the summer trip');
    assert.equal(note.server, PERSONAL_SERVER);

    const other = message('b-1', chatB, 'alice', 'what is the plan for the trip?');
    await store.ingest(other);
    await store.ingest(message('b-0', chatB, 'bob', 'the trip budget is 200'));
    assert.deepEqual((await store.searchMemories(other)).map(item => item.id), [note.id]);
    assert.deepEqual((await store.searchMemories(message('dm-1', dm, 'alice', 'trip plan?'))).map(item => item.id), [note.id]);

    const evidence = await store.retrieve(other, 8);
    assert.ok(evidence.some(item => item.memoryId === note.id));
    assert.ok(!evidence.some(item => item.kind === 'message'), 'a web chat does not search history');
    // Control: the same keyword search finds history in a Discord channel.
    await store.ingest(message('g-1', guild, 'bob', 'the trip budget is 200'));
    assert.ok((await store.retrieve(message('g-2', guild, 'alice', 'trip budget?'), 8)).some(item => item.kind === 'message'));
  });

  test(`${backend}: project chat sees project and personal memories and saves to the project`, { skip }, async t => {
    const store = await openStore(backend, 'user_memory_project', t);
    const projectId = await createProject(store, 'alice');
    const personal = message('a-1', chatA, 'alice', 'Alice likes tea');
    await store.ingest(personal);
    const personalNote = await store.remember(personal, 'Alice likes tea');

    const inProject = { ...message('p-1', chatB, 'alice', 'thesis draft'), project: projectId };
    await store.ingest(inProject);
    const projectNote = await store.remember(inProject, 'The thesis deadline is May');
    assert.equal(projectNote.server, PROJECT_MEMORY_SERVER);
    assert.equal(projectNote.channel, projectMemoryChannel(projectId));

    assert.deepEqual((await store.searchMemories(inProject)).map(item => item.id).sort(), [personalNote.id, projectNote.id].sort());
    assert.equal((await store.updateMemory(inProject, personalNote.id, { content: 'Alice likes green tea' }, 1))?.content, 'Alice likes green tea');
    assert.deepEqual((await store.searchMemories(message('a-2', chatA, 'alice', 'thesis?'))).map(item => item.id), [personalNote.id]);
  });

  test(`${backend}: a web chat still finds its old memories in its own channel, not in another chat`, { skip }, async t => {
    const store = await openStore(backend, 'user_memory_legacy', t);
    // Saved before WP4, when a web chat's memories stayed in its own channel. A non-web surface gives that rule.
    const old = message('a-0', chatA, 'alice', 'Alice old trip plan', { surface: 'discord' });
    await store.ingest(old);
    const oldNote = await store.remember(old, 'Alice old trip plan');
    assert.deepEqual([oldNote.server, oldNote.channel], [server, chatA]);
    assert.deepEqual((await store.searchMemories(message('a-1', chatA, 'alice', 'trip plan?'))).map(item => item.id), [oldNote.id]);
    assert.deepEqual(await store.searchMemories(message('b-1', chatB, 'alice', 'trip plan?')), []);
    // A new memory from this chat goes to the personal scope.
    const fresh = message('a-2', chatA, 'alice', 'fresh note');
    await store.ingest(fresh);
    assert.equal((await store.remember(fresh, 'Alice new plan')).server, PERSONAL_SERVER);
  });

  test(`${backend}: server channel does not see personal memories`, { skip }, async t => {
    const store = await openStore(backend, 'user_memory_server', t);
    const personal = message('a-1', chatA, 'alice', 'Alice plans the summer trip');
    await store.ingest(personal);
    await store.remember(personal, 'Alice plans the summer trip');

    const guildMessage = message('g-1', guild, 'alice', 'what is the trip plan?');
    await store.ingest(guildMessage);
    assert.deepEqual(await store.searchMemories(guildMessage), []);
    const guildNote = await store.remember(guildMessage, 'The server agreed on a trip');
    assert.deepEqual((await store.searchMemories(guildMessage)).map(item => item.id), [guildNote.id]);
  });

  test(`${backend}: private chats have no memory`, { skip }, async t => {
    const store = await openStore(backend, 'user_memory_private', t);
    const hidden = message('i-1', incognito, 'alice', 'secret plan');
    await assert.rejects(store.remember(hidden, 'secret plan'), /Memory is off in private chats/);
    assert.deepEqual(await store.searchMemories(hidden), []);
    assert.deepEqual(await store.retrieve(hidden, 8), []);
  });

  test(`${backend}: userMemories pages and filters the user's own memories`, { skip }, async t => {
    const store = await openStore(backend, 'user_memory_page', t);
    const projectId = await createProject(store, 'alice');
    const bobProject = await createProject(store, 'bob');
    const aliceChat = message('a-1', chatA, 'alice', 'alice notes');
    await store.ingest(aliceChat);
    await store.remember(aliceChat, 'Alice likes tea', { category: 'preference' });
    await store.remember(aliceChat, 'Alice has a cat named Miso');
    const bobChat = message('b-1', chatB, 'bob', 'bob notes');
    await store.ingest(bobChat);
    await store.remember(bobChat, 'Bob likes coffee');
    const aliceProject = { ...message('p-1', chatB, 'alice', 'thesis'), project: projectId };
    await store.ingest(aliceProject);
    await store.remember(aliceProject, 'The thesis deadline is May');
    const bobProjectMessage = { ...message('p-2', chatB, 'bob', 'bob thesis'), project: bobProject };
    await store.ingest(bobProjectMessage);
    await store.remember(bobProjectMessage, 'Bob thesis note');

    const all = await store.userMemories('alice', {});
    assert.equal(all.total, 3);
    assert.ok(all.items.every(item => item.author === 'alice'));
    const page = await store.userMemories('alice', { limit: 2, offset: 2 });
    assert.equal(page.total, 3); assert.equal(page.items.length, 1);
    assert.equal((await store.userMemories('alice', { scope: 'personal' })).total, 2);
    assert.equal((await store.userMemories('alice', { scope: `project:${projectId}` })).total, 1);
    assert.equal((await store.userMemories('alice', { scope: `project:${bobProject}` })).total, 0);
    assert.equal((await store.userMemories('alice', { category: 'preference' })).total, 1);
    assert.equal((await store.userMemories('alice', { query: 'miso' })).total, 1);
  });

  test(`${backend}: forgetOwn refuses another user's memory`, { skip }, async t => {
    const store = await openStore(backend, 'user_memory_forget', t);
    const projectId = await createProject(store, 'alice');
    const bobChat = message('b-1', chatB, 'bob', 'bob notes');
    await store.ingest(bobChat);
    const bobNote = await store.remember(bobChat, 'Bob secret');
    const aliceChat = message('a-1', chatA, 'alice', 'alice notes');
    await store.ingest(aliceChat);
    const aliceNote = await store.remember(aliceChat, 'Alice note');
    const aliceProject = { ...message('p-1', chatB, 'alice', 'thesis'), project: projectId };
    await store.ingest(aliceProject);
    const projectNote = await store.remember(aliceProject, 'Thesis note');

    assert.equal(await store.forgetOwn('alice', bobNote.id), false);
    assert.equal((await store.userMemories('bob', {})).total, 1);
    assert.equal(await store.forgetOwn('alice', aliceNote.id), true);
    assert.equal(await store.forgetOwn('alice', projectNote.id), true);
    assert.equal((await store.userMemories('alice', {})).total, 0);
  });
}

test('private chats have no memory tools, web chats do', t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const discordServer = '12345678901234567';
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test', DISCORD_GUILD_ID: discordServer, DISCORD_CHANNEL_IDS: guild, LLM_MODE: 'mock' });
  const registry = new ToolRegistry(store, async () => true);
  const participation = { options: { enabled: true, contextMessages: 8, cooldownMs: 60000, maxUnsolicitedPerHour: 3 } as ParticipationOptions, diagnostics: new Map<string, string>() };
  registerServerTools(registry, { config, server: discordServer, store, participation, history: new HistoryImporter(discordServer, store, { async fetch() { return []; } }), channels: () => [guild],
    setChannels() {}, async validateChannel() {}, async findChannels() { return ''; }, accepts: () => true, setReplyContext() {}, originMessage: value => value,
    async startTask() { return guild; }, async reconcileTask() { return undefined; }, wakeWorker() {}, async isTeamEditor() { return false; } });
  const hidden = message('i-2', incognito, 'alice', 'remember this');
  const web = message('w-1', chatA, 'alice', 'remember this');
  for (const name of ['memory_remember', 'memory', 'memory_update', 'memory_forget']) {
    assert.ok(registry.refusal(hidden, name), name);
    assert.equal(registry.refusal(web, name), undefined, name);
  }
});
