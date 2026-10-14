import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { ChannelType, ThreadAutoArchiveDuration, type Client } from 'discord.js';
import { DiscordVoice, joinOrigin } from '../src/adapters/discord-voice.js';
import { DiscordServer } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';
import type { Message } from '../src/domain.js';
import { ToolError } from '../src/tools.js';

const guild = '1528063444874432734', text = '1528064977913647236', voice = '1528064977913647300', bot = '1514413259522838528';

/** A Discord server adapter with a text channel, a voice channel and a fake join. The voice channel's join origin is `parent`. */
function fixture(t: TestContext, parent: string | undefined) {
  const sent: string[] = [], threads: unknown[] = [], voiceSent: string[] = [];
  const parentMessage = { id: 'parent-message', startThread: async (options: unknown) => { threads.push(options); return { id: 'thread-1' }; } };
  const channels: Record<string, unknown> = {
    [text]: { id: text, type: ChannelType.GuildText, guildId: guild, send: async (payload: { content: string }) => { sent.push(payload.content); return parentMessage; } },
    [voice]: { id: voice, type: ChannelType.GuildVoice, guildId: guild, send: async (payload: { content: string }) => { voiceSent.push(payload.content); return {}; } },
  };
  const client = Object.assign(new EventEmitter(), {
    user: { id: bot },
    channels: { fetch: async (id: string) => channels[id] ?? null },
    guilds: { fetch: async () => ({ members: { fetch: async () => ({ displayName: 'Ana' }) } }) },
  });
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test-only', DISCORD_GUILD_ID: guild, DISCORD_CHANNEL_IDS: text, LLM_MODE: 'mock' });
  const store = new SQLiteStore(); t.after(() => store.close());
  const adapter = new DiscordServer(config, store, { async *stream() { yield { kind: 'text', payload: { text: 'Hello.' } }; } } as never, client as unknown as Client, guild, undefined);
  Object.assign(adapter, { voice: { taskParent: (channel: string) => channel === voice ? parent : undefined } });
  return { adapter, sent, threads, voiceSent };
}

function voiceMessage(): Message {
  return { id: 'request', server: guild, channel: voice, author: 'person', text: 'Make a plan for the server.', timestamp: 1, source: 'voice' } as unknown as Message;
}

test('voice task thread opens in the join channel', async t => {
  const f = fixture(t, text);
  const id = await f.adapter.createTaskThread(voiceMessage(), 'Plan');
  assert.equal(id, 'thread-1');
  assert.deepEqual(f.sent, ['Voice task from Ana: Make a plan for the server.']);
  assert.deepEqual(f.threads, [{ name: 'Plan', autoArchiveDuration: ThreadAutoArchiveDuration.OneDay }]);
  assert.deepEqual(f.voiceSent, ['-# Task thread: <#thread-1>']);
});

test('voice task with no join channel gives the error', async t => {
  const f = fixture(t, undefined);
  await assert.rejects(f.adapter.createTaskThread(voiceMessage(), 'Plan'), (error: unknown) => error instanceof ToolError && error.message === 'Ask me to join from a text channel to use tasks.');
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.threads, []);
});

test('taskParent is undefined for other channels', async t => {
  const client = Object.assign(new EventEmitter(), { user: { id: bot }, guilds: { fetch: async () => undefined } });
  const idle = new DiscordVoice(client as unknown as Client, guild, {} as never, {} as never, {} as never, () => false, () => '', () => undefined);
  t.after(() => idle.stop());
  assert.equal(idle.taskParent(voice), undefined);
  Object.assign(idle, { session: { channel: voice, origin: text, stop: () => undefined } });
  assert.equal(idle.taskParent(voice), text);
  assert.equal(idle.taskParent(text), undefined);
  assert.equal(idle.taskParent('other-channel'), undefined);
});

test('join origin is the text channel or the parent of a thread', async () => {
  const thread = '1528064977913647400';
  const channels: Record<string, unknown> = {
    [text]: { id: text, type: ChannelType.GuildText },
    [voice]: { id: voice, type: ChannelType.GuildVoice },
    [thread]: { id: thread, type: ChannelType.PublicThread, isThread: () => true, parentId: text },
  };
  const client = { channels: { fetch: async (id: string) => channels[id] ?? null } } as unknown as Client;
  assert.equal(await joinOrigin(client, text), text);
  assert.equal(await joinOrigin(client, thread), text);
  assert.equal(await joinOrigin(client, voice), undefined);
  assert.equal(await joinOrigin(client, 'missing'), undefined);
});
