import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client, type Interaction } from 'discord.js';
import { DiscordAdapter } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';

const one = '1528063444874432734', two = '1528063444874432735', blocked = '1528063444874432736', user = '1514413259522838529';
function fixture(env: Record<string, string> = {}) {
  const permissions = { has: () => true };
  const guild = (id: string, name: string, member: boolean) => ({ id, name, iconURL: () => null,
    members: { fetch: async () => { if (!member) throw new Error('Unknown member'); return { permissions, nickname: 'Server nick', user: { id: user, username: 'ada', globalName: 'Ada Lovelace' } }; }, fetchMe: async () => ({ permissions }) },
    channels: { fetch: async () => new Map() }, commands: { create: async () => ({}) } });
  const guilds = new Map([[one, guild(one, 'Beta', true)], [two, guild(two, 'Alpha', true)], [blocked, guild(blocked, 'Other', false)]]);
  const client = Object.assign(new EventEmitter(), { user: { id: '1514413259522838528', tag: 'slopbot#0' }, destroy: async () => {},
    guilds: { cache: guilds, fetch: async (id: string) => guilds.get(id) }, channels: { fetch: async () => null }, users: { fetch: async () => ({}) } });
  const store = new SQLiteStore();
  const adapter = new DiscordAdapter(loadConfig({ DISCORD_BOT_TOKEN: 'test-only', LLM_MODE: 'mock', ...env }), store, { async *stream() {} }, client as unknown as Client);
  return { adapter, store, client };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('one client serves each server, and the console lists only shared servers', async t => {
  const f = fixture(); t.after(async () => { await f.adapter.stop(); f.store.close(); });
  f.client.emit(Events.ClientReady, f.client); await settle();
  const servers = await f.adapter.consoleServers(user);
  assert.deepEqual(servers.map(item => item.name), ['Alpha', 'Beta']);
  const snapshot = await f.adapter.consoleSnapshot(user, one) as { server: { id: string }; servers: unknown[] };
  assert.equal(snapshot.server.id, one); assert.equal(snapshot.servers.length, 2);
  // The account menu and the greeting show the user's own Discord name, not the server nickname.
  assert.equal(((await f.adapter.consoleSnapshot(user, one)) as { me: { displayName: string } }).me.displayName, 'Ada Lovelace');
  assert.equal((await f.adapter.consoleSnapshot(user) as { server: { id: string } }).server.id, two);
  await assert.rejects(f.adapter.consoleSnapshot(user, blocked), /not both in that server/);
  f.client.emit(Events.GuildDelete, { id: one }); await settle();
  assert.deepEqual((await f.adapter.consoleServers(user)).map(item => item.id), [two]);
});

test('DISCORD_GUILD_IDS limits the servers Slopbot runs in', async t => {
  const f = fixture({ DISCORD_GUILD_IDS: one }); t.after(async () => { await f.adapter.stop(); f.store.close(); });
  f.client.emit(Events.ClientReady, f.client); await settle();
  assert.deepEqual((await f.adapter.consoleServers(user)).map(item => item.id), [one]);
});

test('secondary server slash commands defer and return their own channel settings', async t => {
  const f = fixture({ DISCORD_GUILD_ID: one });
  t.after(async () => { await f.adapter.stop(); f.store.close(); });
  f.client.emit(Events.ClientReady, f.client); await settle();
  const calls: string[] = [];
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  f.client.emit(Events.InteractionCreate, {
    guildId: two, channelId: '1528063444874432737', id: 'command-test', commandName: 'slopbot',
    user: { id: user, username: 'user', globalName: null }, guild: { name: 'Alpha' },
    isButton: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => true, inCachedGuild: () => false,
    options: { getSubcommand: () => 'channels', getString: () => null, getChannel: () => null },
    async deferReply() { calls.push('defer'); },
    async editReply(value: { content: string } | string) { calls.push(typeof value === 'string' ? value : value.content); complete(); },
  } as unknown as Interaction);
  await Promise.race([completed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Command was not acknowledged')), 1000); timer.unref();
  })]);
  assert.deepEqual(calls, ['defer', 'No channels configured.']);
});
