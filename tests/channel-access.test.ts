import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, Events, PermissionFlagsBits, type Client } from 'discord.js';
import { ChannelAccess, type ChannelFacts } from '../src/channel-access.js';
import { discordChannelAccessSource, wireChannelAccessEvents } from '../src/adapters/discord-channel-access.js';
import { DiscordAdapter } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';
import { webTranscriptKey, webTranscriptsEnabled } from '../src/server-tools.js';

const server = '1528063444874432734', text = '1528063444874432735', other = '1528063444874432736', user = '1514413259522838529';
const base: ChannelFacts = { thread: false, privateThread: false, viewChannel: true, readMessageHistory: true, sendMessages: true, sendMessagesInThreads: true, threadMember: false };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/** A source whose answers the test can change and count. */
function fake(initial: Partial<ChannelFacts> | undefined) {
  const state: { facts: ChannelFacts | undefined; calls: number } = { facts: initial === undefined ? undefined : { ...base, ...initial }, calls: 0 };
  return { state, source: { async facts() { state.calls++; return state.facts; } } };
}
const ask = (facts: Partial<ChannelFacts> | undefined) => new ChannelAccess(fake(facts).source).check(server, text, user);

test('channel rules need View Channel, Read Message History and Send Messages', async () => {
  assert.deepEqual(await ask({}), { view: true, send: true });
  assert.deepEqual(await ask({ viewChannel: false }), { view: false, send: false });
  assert.deepEqual(await ask({ readMessageHistory: false }), { view: false, send: false });
  assert.deepEqual(await ask({ sendMessages: false }), { view: true, send: false });
  assert.deepEqual(await ask({ sendMessages: false, sendMessagesInThreads: true }), { view: true, send: false });
});
test('thread rules use Send Messages in Threads, not Send Messages', async () => {
  assert.deepEqual(await ask({ thread: true, sendMessages: false, sendMessagesInThreads: true }), { view: true, send: true });
  assert.deepEqual(await ask({ thread: true, sendMessages: true, sendMessagesInThreads: false }), { view: true, send: false });
});
test('private threads need thread membership to view or send', async () => {
  assert.deepEqual(await ask({ thread: true, privateThread: true, threadMember: false }), { view: false, send: false });
  assert.deepEqual(await ask({ thread: true, privateThread: true, threadMember: true }), { view: true, send: true });
});
test('a user who is not in the guild can neither view nor send', async () => {
  assert.deepEqual(await ask(undefined), { view: false, send: false });
});
test('answers are cached for at most 30 seconds', async () => {
  let now = 0;
  const f = fake({});
  const access = new ChannelAccess(f.source, () => now);
  assert.deepEqual(await access.check(server, text, user), { view: true, send: true });
  now = 29_999; await access.check(server, text, user);
  assert.equal(f.state.calls, 1);
  now = 30_000; f.state.facts = { ...base, viewChannel: false };
  assert.deepEqual(await access.check(server, text, user), { view: false, send: false });
  assert.equal(f.state.calls, 2);
});
const events: [string, unknown[]][] = [
  [Events.GuildMemberUpdate, [{}, { id: user, guild: { id: server } }]],
  [Events.GuildMemberRemove, [{ id: user, guild: { id: server } }]],
  [Events.ChannelUpdate, [{}, { id: text }]],
  [Events.ThreadUpdate, [{}, { id: text }]],
  [Events.ThreadDelete, [{ id: text }]],
  [Events.ChannelDelete, [{ id: text }]],
  [Events.GuildRoleUpdate, [{}, { guild: { id: server } }]],
];
for (const [event, args] of events) {
  test(`${event} clears the cached answer`, async () => {
    const f = fake({}), access = new ChannelAccess(f.source), emitter = new EventEmitter();
    wireChannelAccessEvents(emitter as unknown as Client, access);
    await access.check(server, text, user);
    emitter.emit(event, ...args);
    f.state.facts = { ...base, viewChannel: false };
    assert.deepEqual(await access.check(server, text, user), { view: false, send: false });
    assert.equal(f.state.calls, 2);
  });
}
test('a member update for another user keeps the cached answer', async () => {
  const f = fake({}), access = new ChannelAccess(f.source), emitter = new EventEmitter();
  wireChannelAccessEvents(emitter as unknown as Client, access);
  await access.check(server, text, user);
  emitter.emit(Events.GuildMemberUpdate, {}, { id: other, guild: { id: server } });
  await access.check(server, text, user);
  assert.equal(f.state.calls, 1);
});

function discordClient(granted: bigint[], options: { type?: ChannelType; member?: boolean; threadMember?: boolean; guildId?: string } = {}) {
  const type = options.type ?? ChannelType.GuildText, member = { id: user };
  const channel = {
    id: text, guildId: options.guildId ?? server, type,
    isThread: () => type === ChannelType.PublicThread || type === ChannelType.PrivateThread,
    permissionsFor: (value: unknown) => value === member ? { has: (flag: bigint) => granted.includes(flag) } : null,
    members: { fetch: async () => { if (!options.threadMember) throw new Error('Unknown thread member'); return {}; } },
  };
  return { guilds: { fetch: async (id: string) => { if (id !== server) throw new Error('Unknown guild'); return { members: { fetch: async () => { if (!(options.member ?? true)) throw new Error('Unknown member'); return member; } } }; } },
    channels: { fetch: async (id: string) => id === text ? channel : null } };
}
const discordAccess = (client: ReturnType<typeof discordClient>, id = text) => new ChannelAccess(discordChannelAccessSource(client as unknown as Client)).check(server, id, user);
const chatting = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages];
test('Discord source reads live channel permissions for a member', async () => {
  assert.deepEqual(await discordAccess(discordClient(chatting)), { view: true, send: true });
  assert.deepEqual(await discordAccess(discordClient([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])), { view: true, send: false });
  assert.deepEqual(await discordAccess(discordClient(chatting, { member: false })), { view: false, send: false });
  assert.deepEqual(await discordAccess(discordClient(chatting, { guildId: other })), { view: false, send: false });
});
test('Discord source checks thread membership for private threads', async () => {
  const thread = (threadMember: boolean) => discordClient([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads], { type: ChannelType.PrivateThread, threadMember });
  assert.deepEqual(await discordAccess(thread(false), text), { view: false, send: false });
  assert.deepEqual(await discordAccess(thread(true), text), { view: true, send: true });
  const publicThread = discordClient([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads], { type: ChannelType.PublicThread });
  assert.deepEqual(await discordAccess(publicThread), { view: true, send: true });
});
test('a thread uses the switch of its parent channel', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  store.setSetting(server, webTranscriptKey(text), true);
  assert.equal(webTranscriptsEnabled(store, server, text), true);
  assert.equal(webTranscriptsEnabled(store, server, other), false);
});

function adapterFixture(initialAdmin: boolean) {
  let admin = initialAdmin;
  const permissions = { has: () => admin };
  const names = new Map([[text, { name: 'general' }]]);
  const guild = { id: server, name: 'Beta', iconURL: () => null,
    members: { fetch: async () => ({ permissions }), fetchMe: async () => ({ permissions }) },
    channels: { fetch: async () => names }, commands: { create: async () => ({}) } };
  const client = Object.assign(new EventEmitter(), { user: { id: '1514413259522838528', tag: 'slopbot#0' }, destroy: async () => {},
    guilds: { cache: new Map([[server, guild]]), fetch: async () => guild }, channels: { fetch: async () => null }, users: { fetch: async () => ({}) } });
  const store = new SQLiteStore();
  const adapter = new DiscordAdapter(loadConfig({ DISCORD_BOT_TOKEN: 'test-only', LLM_MODE: 'mock', DISCORD_GUILD_ID: server, DISCORD_CHANNEL_IDS: text }), store, { async *stream() {} }, client as unknown as Client);
  return { adapter, store, client, setAdmin(value: boolean) { admin = value; } };
}
test('web transcript switch is off by default and only server managers can change it', async t => {
  const f = adapterFixture(false); t.after(async () => { await f.adapter.stop(); f.store.close(); });
  f.client.emit(Events.ClientReady, f.client); await settle();
  await assert.rejects(f.adapter.consoleTranscripts(user, server), /Manage Server/);
  await assert.rejects(f.adapter.consoleSetTranscript(user, server, text, true), /Manage Server/);
  assert.equal(webTranscriptsEnabled(f.store, server, text), false);
  f.setAdmin(true);
  assert.deepEqual(await f.adapter.consoleTranscripts(user, server), { channels: [{ id: text, name: 'general', enabled: false }] });
  await assert.rejects(f.adapter.consoleSetTranscript(user, server, other, true), /serves in this server/);
  assert.deepEqual(await f.adapter.consoleSetTranscript(user, server, text, true), { channel: text, enabled: true });
  assert.equal(webTranscriptsEnabled(f.store, server, text), true);
  f.setAdmin(false);
  await assert.rejects(f.adapter.consoleSetTranscript(user, server, text, false), /Manage Server/);
  assert.equal(webTranscriptsEnabled(f.store, server, text), true);
});
