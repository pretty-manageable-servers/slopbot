import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, type Client } from 'discord.js';
import { DiscordServer } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';

const guild = '1528063444874432734', channel = '1528064977913647236', bot = '1514413259522838528';

function fixture() {
  const message = { id: 'source', content: 'request', guildId: guild, channelId: channel,
    author: { id: 'person', username: 'person', bot: false }, member: null, guild: { name: 'Server' }, createdTimestamp: 1,
    attachments: new Map(), embeds: [], reference: null };
  const permissions = { has: () => true };
  const target = { type: ChannelType.GuildText, guildId: guild, isThread: () => false, isTextBased: () => true, isSendable: () => true,
    send: async () => ({ ...message, id: 'reply', author: { ...message.author, id: bot, bot: true } }), permissionsFor: () => permissions,
    messages: { fetch: async () => message } };
  const client = Object.assign(new EventEmitter(), { user: { id: bot }, channels: { fetch: async () => target },
    guilds: { fetch: async () => ({ members: { fetch: async () => ({ permissions }), fetchMe: async () => ({ permissions }) } }) } });
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test-only', DISCORD_GUILD_ID: guild, DISCORD_CHANNEL_IDS: channel, LLM_MODE: 'mock' });
  const store = new SQLiteStore();
  const adapter = new DiscordServer(config, store, { async *stream() { yield { kind: 'text', payload: { text: '' } }; } }, client as unknown as Client, guild, undefined);
  return { adapter, store, target };
}

// Records the users allowed in each posted mention.
function capturePosts(t: { mock: { method: Function } }, target: { send: unknown }) {
  const posts: { content: string; allowedMentions?: { users?: string[] } }[] = [];
  t.mock.method(target, 'send', async (payload: { content: string; allowedMentions?: { users?: string[] } }) => {
    posts.push(payload);
    return { id: 'reply', content: payload.content, author: { id: bot, username: 'slopbot', bot: true }, guildId: guild, channelId: channel, createdTimestamp: 1, attachments: new Map(), embeds: [], reference: null, member: null, guild: { name: 'Server' }, edit: async () => {}, delete: async () => {} };
  });
  return posts;
}

test('schedule owner mention is allowed for command:schedule ids', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const posts = capturePosts(t, f.target);
  await f.adapter.reply({ id: 'command:schedule:abc123:2026-10-14T09:00:00.000Z', server: guild, channel, author: 'owner', text: '' }, '<@owner> hi', 'schedule:abc123:2026-10-14T09:00:00.000Z');
  assert.deepEqual(posts[0]?.allowedMentions?.users, ['owner']);
});

test('other command ids do not allow the owner mention', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const posts = capturePosts(t, f.target);
  await f.adapter.reply({ id: 'command:other:abc123', server: guild, channel, author: 'owner', text: '' }, '<@owner> hi', 'other:abc123');
  assert.equal(posts[0]?.allowedMentions?.users, undefined);
});
