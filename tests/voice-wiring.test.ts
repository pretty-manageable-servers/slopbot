import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { ChannelType, type Client } from 'discord.js';
import { DiscordServer } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';
import type { Message } from '../src/domain.js';

const guild = '1528063444874432734', channel = '1528064977913647236', bot = '1514413259522838528';

/** A Discord server adapter whose voice object records speak calls instead of playing audio. */
function fixture(t: TestContext) {
  const permissions = { has: () => true };
  const sent = { id: 'reply', guildId: guild, channelId: channel, content: '', author: { id: bot, username: 'slopbot', bot: true }, attachments: new Map(), embeds: [], reference: null, mentions: { users: new Map() }, member: null, guild: { name: 'Server' }, createdTimestamp: 1, editedTimestamp: null };
  const target = { type: ChannelType.GuildText, guildId: guild, isThread: () => false, isTextBased: () => true, isSendable: () => true, send: async () => sent, permissionsFor: () => permissions, messages: { fetch: async () => undefined } };
  const client = Object.assign(new EventEmitter(), { user: { id: bot }, channels: { fetch: async () => target }, guilds: { fetch: async () => ({ members: { fetch: async () => ({ permissions }), fetchMe: async () => ({ permissions }) } }) } });
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test-only', DISCORD_GUILD_ID: guild, DISCORD_CHANNEL_IDS: channel, LLM_MODE: 'mock' });
  const store = new SQLiteStore(); t.after(() => store.close());
  const adapter = new DiscordServer(config, store, { async *stream() { yield { kind: 'text', payload: { text: 'Hello.' } }; } } as never, client as unknown as Client, guild, undefined);
  const spoken: unknown[][] = [];
  Object.assign(adapter, { voice: { speak: async (...args: unknown[]) => { spoken.push(args); }, cue: async () => {}, stop: () => {} } });
  return { adapter, spoken };
}

function message(source?: 'voice'): Message {
  return { id: 'request', server: guild, channel, author: 'person', text: 'request', timestamp: 1, ...(source ? { source } : {}) } as unknown as Message;
}

test('voice message reply is spoken', async t => {
  const f = fixture(t);
  await f.adapter.reply(message('voice'), 'Hello there.');
  assert.deepEqual(f.spoken, [[channel, 'Hello there.']]);
});

test('web message reply is not spoken', async t => {
  const f = fixture(t);
  await f.adapter.reply(message(), 'Hello there.');
  assert.deepEqual(f.spoken, []);
});
