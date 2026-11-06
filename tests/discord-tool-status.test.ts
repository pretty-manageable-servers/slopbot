import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, type Client } from 'discord.js';
import { DiscordServer } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';
import { engineEvents } from '../src/engine/event-log.js';
import { privateChannel } from '../src/private-chat.js';

const guild = '1528063444874432734', channel = '1528064977913647236', thread = '1528064977913647299', bot = '1514413259522838528';

function fixture() {
  const sent: { content: string; reply?: unknown }[] = [], edits: string[] = [];
  const target = { type: ChannelType.GuildText, guildId: guild, isThread: () => false, isTextBased: () => true, isSendable: () => true,
    send: async (payload: { content: string; reply?: unknown }) => { sent.push(payload); return { async edit(content: string) { edits.push(content); }, async delete() {} }; } };
  const client = Object.assign(new EventEmitter(), { user: { id: bot }, channels: { fetch: async () => target }, guilds: { fetch: async () => ({}) } });
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test-only', DISCORD_GUILD_ID: guild, DISCORD_CHANNEL_IDS: channel, LLM_MODE: 'mock' });
  const store = new SQLiteStore();
  engineEvents.attach(store);
  const adapter = new DiscordServer(config, store, { async *stream() { /* none */ } }, client as unknown as Client, guild, undefined);
  adapter['bot']['tasks'].add(thread);
  return { adapter, store, sent, edits };
}

const settle = async () => { await engineEvents.idle(); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const running = (turn: string, call = 'call') => ({ type: 'tool.status' as const, turn, call, name: 'web_search', status: 'running' as const, input: { query: 'weather' } });

for (const turn of ['task-seed:source', 'command:reminder:source', 'source']) test(`tool.status events post a status message with a valid reply reference for ${turn}`, async t => {
  const f = fixture();
  t.after(() => { f.adapter['unlistenTools'](); f.store.close(); });
  engineEvents.publish({ server: guild, channel: thread }, running(turn));
  await settle();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.content, /-# now: 🔎 "weather"$/);
  assert.equal(Boolean(f.sent[0]!.reply), turn === 'source');
});

test('a later tool.status of the same request edits the status message, and an event without a saved row still shows', async t => {
  const f = fixture();
  t.after(() => { f.adapter['unlistenTools'](); f.store.close(); });
  // The transcript switch is off in this channel, so the events carry no seq.
  engineEvents.publish({ server: guild, channel }, running('source'));
  engineEvents.publish({ server: guild, channel }, { ...running('source'), status: 'completed', durationMs: 900 });
  await settle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.edits.length, 1);
});

test('web chats and other servers get no Discord status message', async t => {
  const f = fixture();
  t.after(() => { f.adapter['unlistenTools'](); f.store.close(); });
  engineEvents.publish({ server: guild, channel: privateChannel('chat1') }, running('source'));
  engineEvents.publish({ server: 'other', channel }, running('source'));
  await settle();
  assert.equal(f.sent.length, 0);
});
