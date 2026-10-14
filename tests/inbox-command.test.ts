import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client, type Interaction } from 'discord.js';
import { DiscordAdapter, buildInboxCommand } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';

const one = '1528063444874432734', two = '1528063444874432735', user = '1514413259522838529', bob = '1514413259522838600', channel = '1528063444874432737';
const first = 'aaaaaaaa-0000-4000-8000-000000000001', second = 'bbbbbbbb-0000-4000-8000-000000000002';
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

// Like the discord-servers fixture. Every channel is visible to the user and Slopbot, so the inbox shows its items.
function fixture(registered: unknown[] = []) {
  const permissions = { has: () => true };
  const visible = { permissionsFor: () => ({ has: () => true }), isThread: () => false, type: 0 };
  const guild = (id: string, name: string) => ({ id, name, iconURL: () => null,
    members: { fetch: async () => ({ permissions, nickname: 'Server nick', user: { id: user, username: 'ada', globalName: 'Ada Lovelace' } }), fetchMe: async () => ({ permissions }) },
    channels: { fetch: async () => new Map() }, commands: { create: async () => ({}), set: async (list: unknown[]) => { registered.push(...list); return new Map(); } } });
  const guilds = new Map([[one, guild(one, 'Beta')], [two, guild(two, 'Alpha')]]);
  const client = Object.assign(new EventEmitter(), { user: { id: '1514413259522838528', tag: 'slopbot#0' }, destroy: async () => {},
    guilds: { cache: guilds, fetch: async (id: string) => guilds.get(id) },
    channels: { fetch: async (id: string) => ({ ...visible, id, guildId: two }) }, users: { fetch: async () => ({}) } });
  const store = new SQLiteStore();
  const adapter = new DiscordAdapter(loadConfig({ DISCORD_BOT_TOKEN: 'test-only', LLM_MODE: 'mock' }), store, { async *stream() {} }, client as unknown as Client);
  return { adapter, store, client };
}

async function open(t: { after(fn: () => unknown): void }, registered: unknown[] = []) {
  const f = fixture(registered);
  t.after(async () => { await f.adapter.stop(); f.store.close(); });
  f.client.emit(Events.ClientReady, f.client); await settle();
  return f;
}

// Sends /inbox in the test server and returns the reply and the defer options.
async function runInbox(f: ReturnType<typeof fixture>, options: { done?: string; all?: boolean } = {}) {
  let resolveReply!: (value: { content: string }) => void;
  const replied = new Promise<{ content: string }>(resolve => { resolveReply = resolve; });
  let defer: unknown;
  f.client.emit(Events.InteractionCreate, {
    guildId: two, id: 'inbox-test', commandName: 'inbox',
    user: { id: user, username: 'ada', globalName: null },
    isButton: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => true, isMessageContextMenuCommand: () => false,
    options: {
      getString: (name: string) => name === 'done' ? (options.done ?? null) : null,
      getBoolean: (name: string) => name === 'all' ? (options.all ?? null) : null,
    },
    async deferReply(value: unknown) { defer = value; },
    async editReply(value: { content: string }) { resolveReply(value); },
  } as unknown as Interaction);
  const reply = await Promise.race([replied, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Command was not answered')), 1000); timer.unref();
  })]);
  return { reply: reply.content, defer };
}

function addItem(f: ReturnType<typeof fixture>, id: string, summary: string, createdAt: number, doneAt: number | null = null) {
  return f.store.addInboxItem({ id, server: two, target: user, sender: bob, channel, sourceIds: ['900000000000000001'], summary, created_at: createdAt, done_at: doneAt });
}

test('inbox command lists open items', async t => {
  const f = await open(t);
  const now = Date.now();
  await addItem(f, first, 'Ship the fix on Friday', now - 60_000);
  await addItem(f, second, 'Already handled', now - 120_000, now - 30_000);
  const { reply, defer } = await runInbox(f);
  assert.deepEqual(defer, { flags: 64 }, 'the reply is ephemeral');
  assert.match(reply, /^`aaaaaaaa` from <@1514413259522838600> · <t:\d+:R> · Ship the fix on Friday · https:\/\/discord\.com\/channels\/1528063444874432735\/1528063444874432737\/900000000000000001$/);
  assert.doesNotMatch(reply, /Already handled/, 'done items are left out');
  assert.ok(reply.length <= 2000);
  assert.deepEqual((await f.adapter.consoleInbox(user, two)).map(item => item.id), [first], 'the console reads the same open items');
});

test('inbox command marks done by id prefix', async t => {
  const f = await open(t);
  const now = Date.now();
  await addItem(f, first, 'First item', now - 60_000);
  await addItem(f, second, 'Second item', now - 120_000);
  assert.equal((await runInbox(f, { done: 'aaaaaaaa, zzzzzzzz' })).reply, 'Marked 1 items done.', 'an unknown prefix is ignored');
  assert.match((await runInbox(f)).reply, /^`bbbbbbbb` from /, 'the other item is still open');
  assert.equal((await runInbox(f, { done: 'all' })).reply, 'Marked 1 items done.');
  assert.equal((await runInbox(f)).reply, 'Your inbox is empty.');
});

test('inbox command empty', async t => {
  const f = await open(t);
  const { reply, defer } = await runInbox(f);
  assert.equal(reply, 'Your inbox is empty.');
  assert.deepEqual(defer, { flags: 64 });
});

test('inbox command is registered', async t => {
  const registered: { name: string; options?: { name: string; type: number }[] }[] = [];
  await open(t, registered);
  const command = registered.find(item => item.name === 'inbox');
  assert.ok(command, 'the guild gets a top-level /inbox command');
  assert.deepEqual(command.options?.map(option => [option.name, option.type]), [['done', 3], ['all', 5]]);
  const built = buildInboxCommand().toJSON() as { name: string; options: { name: string }[] };
  assert.deepEqual(built.options.map(option => option.name), ['done', 'all']);
});
