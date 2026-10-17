import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { DiscordAdapter } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';
import type { LLM } from '../src/ports.js';
import { directMessageChannel } from '../src/private-chat.js';

const one = '1528063444874432734', two = '1528063444874432735', blocked = '1528063444874432736', user = '1514413259522838529';
function fixture(env: Record<string, string> = {}, llm: LLM = { async *stream() {} }) {
  const channels = new Map<string, unknown>();
  const permissions = { has: () => true };
  const guild = (id: string, name: string, member: boolean) => ({ id, name, iconURL: () => null,
    members: { fetch: async () => { if (!member) throw new Error('Unknown member'); return { permissions, nickname: 'Server nick', user: { id: user, username: 'ada', globalName: 'Ada Lovelace' } }; }, fetchMe: async () => ({ permissions }) },
    channels: { fetch: async () => new Map() }, commands: { create: async () => ({}) } });
  const guilds = new Map([[one, guild(one, 'Beta', true)], [two, guild(two, 'Alpha', true)], [blocked, guild(blocked, 'Other', false)]]);
  const client = Object.assign(new EventEmitter(), { user: { id: '1514413259522838528', tag: 'slopbot#0' }, destroy: async () => {},
    guilds: { cache: guilds, fetch: async (id: string) => guilds.get(id) }, channels: { fetch: async (id: string) => channels.get(id) ?? null }, users: { fetch: async () => ({}) } });
  const store = new SQLiteStore();
  const adapter = new DiscordAdapter(loadConfig({ DISCORD_BOT_TOKEN: 'test-only', LLM_MODE: 'mock', ...env }), store, llm, client as unknown as Client);
  return { adapter, store, client, channels };
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

test('DMs reply without mentions, keep private history, and track edits and deletions', async t => {
  let modelCalls = 0;
  const f = fixture({ DISCORD_GUILD_IDS: one }, { async *stream() { modelCalls++; yield { kind: 'text', payload: { text: 'DM reply' } }; } });
  t.after(async () => { await f.adapter.stop(); f.store.close(); });
  const channelId = '1528063444874432790';
  const incoming = { id: 'dm-request', guildId: null, channelId, content: 'hello privately', author: { id: user, username: 'ada', bot: false }, attachments: new Map(), embeds: [], mentions: { users: new Map() }, createdTimestamp: Date.now(), editedTimestamp: null, partial: false };
  const sent: string[] = [];
  f.channels.set(channelId, { isTextBased: () => true, isSendable: () => true, sendTyping: async () => {}, async send(payload: { content: string }) { sent.push(payload.content); return { ...incoming, id: `dm-reply-${sent.length}`, content: payload.content, author: { id: f.client.user.id, username: 'slopbot', bot: true } }; } });
  f.client.emit(Events.ClientReady, f.client); await settle();
  f.client.emit(Events.MessageCreate, incoming);
  const deadline = Date.now() + 5000;
  while (!sent.length && Date.now() < deadline) await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /DM reply/);
  assert.equal(modelCalls, 1);
  const saved = await f.store.canonicalMessage(one, incoming.id);
  assert.equal(saved?.channel, directMessageChannel(channelId));
  assert.equal(saved?.addressed, true);
  assert.equal((await f.store.canonicalMessage(one, 'dm-reply-1'))?.channel, directMessageChannel(channelId));
  assert.deepEqual((await f.store.searchHistory({ server: one, channel: '1528063444874432791', query: 'privately', mode: 'keyword', limit: 10 })).messages, []);
  f.client.emit(Events.MessageUpdate, incoming, { ...incoming, content: 'edited privately', editedTimestamp: Date.now() + 100 });
  await settle();
  assert.equal((await f.store.canonicalMessage(one, incoming.id))?.text, 'edited privately');
  f.client.emit(Events.MessageDelete, incoming); await settle();
  assert.equal(await f.store.canonicalMessage(one, incoming.id), undefined);
  assert.equal(modelCalls, 1);
});

test('DMs from bots and users without shared enabled servers are ignored', async t => {
  let modelCalls = 0;
  const f = fixture({ DISCORD_GUILD_IDS: blocked }, { async *stream() { modelCalls++; } });
  t.after(async () => { await f.adapter.stop(); f.store.close(); });
  f.client.emit(Events.ClientReady, f.client); await settle();
  const message = { id: 'ignored-dm', guildId: null, channelId: '1528063444874432790', author: { id: user, bot: false } };
  f.client.emit(Events.MessageCreate, message); await settle();
  f.client.emit(Events.MessageCreate, { ...message, author: { id: user, bot: true } }); await settle();
  assert.equal(modelCalls, 0);
  assert.equal(await f.store.canonicalMessage(blocked, message.id), undefined);
});
