import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { ChannelType, Collection, type Client } from 'discord.js';
import { VoiceConnectionStatus, type joinVoiceChannel } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { pcmWav } from '../src/adapters/audio.js';
import { DiscordVoice, type VoicePoster } from '../src/adapters/discord-voice.js';
import { DEGRADED_NOTE, type LlmCaller, type LlmRouter } from '../src/llm-mode.js';
import type { LLM } from '../src/ports.js';
import { UsageMeter } from '../src/usage-meter.js';
import { UserLimiter } from '../src/user-limiter.js';
import type { ToolDefinition, ToolRegistry, ToolContext } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_VOICE_INSTRUCTIONS } from '../src/voice-rules.js';

type PostInput = Parameters<VoicePoster['reply']>[0];

function thunderWav(): Buffer {
  const wav = pcmWav(Buffer.from([1, 0, 254, 255]));
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
  return wav;
}

/** Waits for a condition by yielding to the event loop. */
async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 1000; index++) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}


function meter() {
  const limiter = { check: async () => ({ allowed: true as const }), record: async () => {}, overGrace: async () => false } as unknown as UserLimiter;
  return new UsageMeter(limiter, () => ({}), { input: 0, output: 0, cached_input: 0 });
}

/** The AI provider. Transcripts return `transcript` unless `transcribeStatus` is set; speech fails with `speechStatus`. */
function stubProvider(t: TestContext, options: { transcript?: string; transcribeStatus?: number; speechStatus?: number }) {
  const calls = { transcriptions: 0, speeches: [] as string[] };
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('transcriptions')) {
      calls.transcriptions++;
      return options.transcribeStatus ? new Response('Service unavailable', { status: options.transcribeStatus }) : Response.json({ text: options.transcript ?? 'Hello' });
    }
    calls.speeches.push((JSON.parse(String(init?.body)) as { input: string }).input);
    return options.speechStatus ? new Response('Service unavailable', { status: options.speechStatus }) : new Response(new Uint8Array(thunderWav()));
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  return calls;
}

/** A router whose model is up or down. It records every caller it is asked about. */
function fakeRouter(offline: boolean) {
  const state = { offline };
  const callers: LlmCaller[] = [];
  const llm = { model: 'nimbus' } as unknown as LLM;
  const router: LlmRouter = { select: who => { if (who) callers.push(who); return state.offline ? undefined : llm; } };
  return { router, callers, state };
}

/**
 * A joined voice session with fake Discord objects. One speaker, `user`, is in the channel.
 * Pass `withRouter: false` for a session with no router, and `replies: 'text'` for a text session.
 */
async function rig(t: TestContext, options: { offline?: boolean; withRouter?: boolean; replies?: 'voice' | 'text'; transcript?: string; transcribeStatus?: number; speechStatus?: number } = {}) {
  const provider = stubProvider(t, options);
  const posts: PostInput[] = [];
  const poster: VoicePoster = { reply: async input => { posts.push(input); return { id: `web-${posts.length}`, messageId: `message-${posts.length}`, status: 'posted', via: 'bot' }; } };
  const notices: string[] = [];
  const message = { react: async () => {}, reactions: { cache: new Map() }, delete: async () => {} };
  const channel = { id: 'channel', type: ChannelType.GuildVoice, members: new Collection([['user', { user: { bot: false } }]]), permissionsFor: () => ({ has: () => true }), isTextBased: () => true, isSendable: () => true, isThread: () => false, messages: { fetch: async () => message }, send: async (notice: { content: string }) => { notices.push(notice.content); return message; } };
  const member = { user: { bot: false }, displayName: 'Human', voice: { channelId: channel.id, channel } };
  const guild = { id: 'guild', members: { fetch: async () => member, fetchMe: async () => ({}), cache: new Map([['user', member]]) }, channels: { cache: new Map([[channel.id, channel]]) } };
  const client = Object.assign(new EventEmitter(), { user: { id: 'bot' }, guilds: { fetch: async () => guild }, channels: { fetch: async () => channel } }) as unknown as Client;
  // Eight 20 ms frames are 160 ms of speech, which passes the 100 ms minimum.
  const codec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const packet = codec.encode(Buffer.alloc(3840), 960);
  codec.delete();
  const receiver = Object.assign(new EventEmitter(), { speaking: new EventEmitter(), subscribe: () => {
    const stream = Object.assign(new EventEmitter(), { destroy: () => {} });
    queueMicrotask(() => { for (let index = 0; index < 8; index++) stream.emit('data', packet); stream.emit('end'); });
    return stream;
  } });
  let destroyed = false;
  const connection = Object.assign(new EventEmitter(), { state: { status: VoiceConnectionStatus.Ready }, receiver, subscribe: () => {}, destroy: () => { destroyed = true; } });
  const connect = (() => connection) as unknown as typeof joinVoiceChannel;
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test', LLM_API_KEY: 'test' });
  const { router, callers, state } = fakeRouter(options.offline ?? false);
  const voice = new DiscordVoice(client, 'guild', config, poster, meter(), () => false, () => DEFAULT_VOICE_INSTRUCTIONS, async () => {}, connect, undefined, options.withRouter === false ? undefined : router);
  t.after(() => voice.stop());
  let tool!: ToolDefinition;
  voice.register({ register: (definition: ToolDefinition) => { tool = definition; } } as unknown as ToolRegistry);
  await tool.execute({ message: { author: 'user' }, isAdmin: false } as ToolContext, { action: 'join', ...(options.replies ? { reply: options.replies } : {}) });
  // The speaker starts talking. The real speaking event passes the user ID.
  const talk = () => connection.receiver.speaking.emit('start', 'user');
  return { voice, provider, posts, notices, callers, state, talk, destroyed: () => destroyed };
}

test('transcribes when offline', async t => {
  const r = await rig(t, { offline: true, transcript: 'Hello there' });
  r.talk();
  await until(() => r.posts.length === 1);
  assert.equal(r.provider.transcriptions, 1);
  assert.deepEqual(r.posts[0], { user: 'user', server: 'guild', channel: 'channel', text: 'Hello there', kind: 'voice' });
  assert.deepEqual(r.callers, [{ user: 'user', server: 'guild', private: false }]);
  await until(() => r.provider.speeches.includes(DEGRADED_NOTE));
});

test('leaves when transcription down', async t => {
  const r = await rig(t, { transcribeStatus: 503 });
  r.talk();
  await until(() => r.destroyed());
  assert.deepEqual(r.provider.speeches, [DEGRADED_NOTE]);
  assert.equal(r.posts.length, 0);
  assert.equal(r.notices.some(notice => notice.includes('failed')), false);
});

test('without a router a transcription outage does not leave', async t => {
  const r = await rig(t, { transcribeStatus: 503, withRouter: false });
  r.talk();
  await until(() => r.notices.some(notice => notice.includes('failed')));
  assert.equal(r.destroyed(), false);
  assert.deepEqual(r.provider.speeches, []);
});
