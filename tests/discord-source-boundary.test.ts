import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, type Client, type Message as DiscordMessage } from 'discord.js';
import { DiscordServer } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';

const guild = '1528063444874432734', channel = '1528064977913647236', bot = '1514413259522838528';
function fixture(fresh: { content: string; url: string; size?: number; author?: string }) {
  const message = { id: 'source', content: fresh.content, guildId: guild, channelId: channel,
    author: { id: fresh.author ?? 'person', username: 'person', bot: fresh.author === bot }, member: null, guild: { name: 'Server' }, createdTimestamp: 1,
    attachments: new Map([['file', { name: 'sample.txt', url: fresh.url, size: fresh.size ?? 13, contentType: 'text/plain' }]]), embeds: [], reference: null };
  const permissions = { has: () => true };
  const target = { type: ChannelType.GuildText, guildId: guild, isThread: () => false, isTextBased: () => true, isSendable: () => true, send: async () => ({...message, id:'reply', author:{...message.author,id:bot,bot:true}}), permissionsFor: () => permissions, messages: { fetch: async () => message } };
  const client = Object.assign(new EventEmitter(), { user: { id: bot }, channels: { fetch: async () => target }, guilds: { fetch: async () => ({ members: { fetch: async () => ({ permissions }), fetchMe: async () => ({ permissions }) } }) } });
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test-only', DISCORD_GUILD_ID: guild, DISCORD_CHANNEL_IDS: channel, LLM_MODE: 'mock' });
  const store = new SQLiteStore(); let generations = 0;
  const adapter = new DiscordServer(config, store, { async *stream() { generations++; yield { kind: 'text', payload: { text: 'File report.' } }; } }, client as unknown as Client, guild, undefined);
  return { adapter, store, message, target, generations: () => generations };
}

test('Discord normalization marks its own progress UI transient and keeps human text semantic', t => {
  const f = fixture({ content: '**Working**\n1. `history_read`: running', url: 'https://cdn.discordapp.com/a/file.txt', author: bot });
  t.after(() => f.store.close());
  const normalized = f.adapter['normalize'](f.message as unknown as DiscordMessage);
  assert.ok('transient' in normalized && normalized.transient === true);
  const human = f.adapter['normalize']({ ...f.message, author: { ...f.message.author, id: 'person', bot: false } } as unknown as DiscordMessage);
  assert.ok(!('transient' in human) || human.transient !== true);
});
