import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { ChannelType, Collection, type Client } from 'discord.js';
import { VoiceConnectionStatus, type joinVoiceChannel } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { PmAudio, pcmWav, speechPcm } from '../src/adapters/audio.js';
import { DiscordVoice, type VoicePoster } from '../src/adapters/discord-voice.js';
import { UsageMeter } from '../src/usage-meter.js';
import { UserLimiter } from '../src/user-limiter.js';
import type { ToolDefinition, ToolRegistry, ToolContext } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import { VOICE_CUE_TEXT, VOICE_TURN_TIMEOUT_MS, spokenText } from '../src/voice-rules.js';

function thunderWav(): Buffer {
  const wav = pcmWav(Buffer.from([1, 0, 254, 255]));
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
  return wav;
}

test('Discord PCM produces valid WAV and Thunder WAV converts into 48 kHz stereo', () => {
  const wav = pcmWav(Buffer.alloc(192000));
  assert.equal(wav.readUInt32LE(40), 192000);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt16LE(22), 2);
  const pcm = speechPcm(thunderWav());
  assert.deepEqual([...new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)], [1, 1, 1, 1, -2, -2, -2, -2]);
  assert.throws(() => speechPcm(wav), /24 kHz/);
  assert.throws(() => speechPcm(thunderWav().subarray(0, 45)), /Truncated/);
  assert.throws(() => speechPcm(Buffer.from('not audio')), /not WAV/);
});

test('Opus codec decodes real encoded voice frames without a native addon', () => {
  const codec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  try { assert.equal(codec.decode(codec.encode(Buffer.alloc(3840), 960)).length, 3840); }
  finally { codec.delete(); }
});

test('PMServers requests use squall multipart PCM WAV and thunder JSON WAV', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return String(url).endsWith('transcriptions') ? Response.json({ text: ' hello ' }) : new Response(new Uint8Array(thunderWav()));
  };
  const audio = new PmAudio('https://example.com/ai/v1/', 'test-key', 'alloy', fetcher);
  const signal = new AbortController().signal;
  assert.equal(await audio.transcribe(Buffer.alloc(3840), signal), 'hello');
  const request = requests[0]!;
  assert.equal(request.url, 'https://example.com/ai/v1/audio/transcriptions');
  const form = request.init.body as FormData;
  assert.equal(form.get('model'), 'squall');
  assert.equal((form.get('file') as Blob).type, 'audio/wav');
  const wav = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
  assert.equal(wav.readUInt32LE(40), 3840);
  assert.equal(await audio.speak('Hello', signal).then(pcm => pcm.length), 16);
  assert.deepEqual(JSON.parse(requests[1]!.init.body as string), { model: 'thunder', input: 'Hello', voice: 'alloy', response_format: 'wav' });
  await assert.rejects(audio.speak('x'.repeat(4097), signal), /4096/);
});

test('audio propagates provider errors and invalid transcription responses', async () => {
  const signal = new AbortController().signal;
  const audio = new PmAudio('https://example.com', 'test', 'alloy', async () => Response.json({ error: { message: 'Model access denied' } }, { status: 403 }));
  await assert.rejects(audio.transcribe(Buffer.alloc(3840), signal), (error: Error) => {
    assert.equal(error.message, 'AI provider returned HTTP 403');
    assert.equal((error.cause as Error).message, 'Model access denied'); return true;
  });
  const invalid = new PmAudio('https://example.com', 'test', 'alloy', async () => Response.json({ text: 1 }));
  await assert.rejects(invalid.transcribe(Buffer.alloc(3840), signal), /no text/);
});

type PostInput = Parameters<VoicePoster['reply']>[0];

/** Waits for a condition by yielding to the event loop. It uses no timers, so mock timers can run. */
async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 1000; index++) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

/** Lets pending async work finish, for checks that something did NOT happen. */
async function settle(): Promise<void> {
  for (let index = 0; index < 50; index++) await new Promise(resolve => setImmediate(resolve));
}

function meter(limit = 1_000_000) {
  let spent = 0;
  const limiter = { check: async () => spent < limit ? { allowed: true as const } : { allowed: false as const, resetAt: 1 }, record: async (_user: string, cost: number) => { spent += cost; }, overGrace: async () => spent >= limit } as unknown as UserLimiter;
  return { usage: new UsageMeter(limiter, () => ({}), { input: 0, output: 0, cached_input: 0 }), spent: () => spent };
}

/** Replaces the AI provider. Transcripts return `transcript`; speech returns a short WAV. */
function stubProvider(t: TestContext, transcript: string) {
  const calls = { transcriptions: 0, speeches: [] as string[] };
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('transcriptions')) { calls.transcriptions++; return Response.json({ text: transcript }); }
    calls.speeches.push((JSON.parse(String(init?.body)) as { input: string }).input);
    return new Response(new Uint8Array(thunderWav()));
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  return calls;
}

/** A joined voice session with fake Discord objects. One speaker, `user`, is in the channel. */
async function rig(t: TestContext, transcript = 'Hello') {
  const provider = stubProvider(t, transcript);
  const { usage, spent } = meter();
  const posts: PostInput[] = [];
  const poster: VoicePoster = { reply: async input => { posts.push(input); return { id: `web-${posts.length}`, messageId: `message-${posts.length}`, status: 'posted', via: 'bot' }; } };
  const notices: string[] = [];
  const channel = { id: 'channel', type: ChannelType.GuildVoice, members: new Collection([['user', { user: { bot: false } }]]), permissionsFor: () => ({ has: () => true }), isSendable: () => true, send: async (notice: { content: string }) => { notices.push(notice.content); } };
  const member = { user: { bot: false }, displayName: 'Human', voice: { channelId: channel.id, channel } };
  const guild = { id: 'guild', members: { fetch: async () => member, fetchMe: async () => ({}), cache: new Map([['user', member]]) }, channels: { cache: new Map([[channel.id, channel]]) } };
  const client = Object.assign(new EventEmitter(), { user: { id: 'bot' }, guilds: { fetch: async () => guild } }) as unknown as Client;
  // Eight 20 ms frames are 160 ms of speech, which passes the 100 ms minimum.
  const codec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const packet = codec.encode(Buffer.alloc(3840), 960);
  codec.delete();
  const receiver = Object.assign(new EventEmitter(), { speaking: new EventEmitter(), subscribe: () => {
    const stream = Object.assign(new EventEmitter(), { destroy: () => {} });
    queueMicrotask(() => { for (let index = 0; index < 8; index++) stream.emit('data', packet); stream.emit('end'); });
    return stream;
  } });
  const connection = Object.assign(new EventEmitter(), { state: { status: VoiceConnectionStatus.Ready }, receiver, subscribe: () => {}, destroy: () => {} });
  const connect = (() => connection) as unknown as typeof joinVoiceChannel;
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test', LLM_API_KEY: 'test' });
  const voice = new DiscordVoice(client, 'guild', config, poster, usage, () => false, connect);
  t.after(() => voice.stop());
  let tool!: ToolDefinition;
  voice.register({ register: (definition: ToolDefinition) => { tool = definition; } } as unknown as ToolRegistry);
  await tool.execute({ message: { author: 'user' }, isAdmin: false } as ToolContext, { action: 'join' });
  // The speaker starts talking. The real speaking event passes the user ID.
  const talk = () => connection.receiver.speaking.emit('start', 'user');
  return { voice, provider, posts, notices, spent, talk };
}

test('transcript is posted with kind voice', async t => {
  const r = await rig(t, 'Hello there');
  r.talk();
  await until(() => r.posts.length === 1);
  assert.deepEqual(r.posts[0], { user: 'user', server: 'guild', channel: 'channel', text: 'Hello there', kind: 'voice' });
});

test('speech ignored while turn is busy', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  r.talk();
  await settle();
  assert.equal(r.posts.length, 1);
  assert.equal(r.provider.transcriptions, 1);
});

test('speak plays spokenText and ends the turn', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  const reply = '  Hello back.  ';
  await r.voice.speak('channel', reply);
  assert.deepEqual(r.provider.speeches, [spokenText(reply)]);
  assert.equal(r.notices.some(notice => notice.includes('failed')), false);
  // The turn is over, so the next speech is accepted.
  r.talk();
  await until(() => r.posts.length === 2);
});

test('speak in other channel is ignored', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  await r.voice.speak('elsewhere', 'Hi');
  assert.deepEqual(r.provider.speeches, []);
  // The turn is still pending, so new speech stays ignored.
  r.talk();
  await settle();
  assert.equal(r.provider.transcriptions, 1);
});

test('turn ends after timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  r.talk();
  await settle();
  assert.equal(r.provider.transcriptions, 1);
  t.mock.timers.tick(VOICE_TURN_TIMEOUT_MS);
  r.talk();
  await until(() => r.posts.length === 2);
});

test('cue plays once per turn', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  await r.voice.cue('channel');
  await r.voice.cue('channel');
  assert.deepEqual(r.provider.speeches, [VOICE_CUE_TEXT]);
  await r.voice.speak('channel', 'Done.');
  // The next turn plays the cached cue. No new speech request is made for it.
  r.talk();
  await until(() => r.posts.length === 2);
  await r.voice.cue('channel');
  assert.deepEqual(r.provider.speeches, [VOICE_CUE_TEXT, 'Done.']);
  assert.equal(r.notices.some(notice => notice.includes('failed')), false);
});

test('empty transcript posts nothing', async t => {
  const r = await rig(t, '');
  r.talk();
  await until(() => r.provider.transcriptions === 1);
  await settle();
  assert.equal(r.posts.length, 0);
  // The empty turn ended, so the next speech is accepted.
  r.talk();
  await until(() => r.provider.transcriptions === 2);
});

test('voice configuration can disable sessions and select the Thunder voice', () => {
  const env = { DISCORD_BOT_TOKEN: 'test', LLM_MODE: 'mock' };
  assert.equal(loadConfig(env).voice?.voice, 'alloy');
  assert.equal(loadConfig({ ...env, VOICE_ENABLED: 'false' }).voice, undefined);
  assert.equal(loadConfig({ ...env, VOICE_NAME: 'custom' }).voice?.voice, 'custom');
  assert.throws(() => loadConfig({ ...env, VOICE_ENABLED: 'yes' }), /VOICE_ENABLED/);
});

test('voice join requires the requester to be in a voice channel; stop removes its listener', async () => {
  const client = Object.assign(new EventEmitter(), { guilds: { fetch: async () => ({ members: { fetch: async () => ({ voice: {} }) } }) } }) as unknown as Client;
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test', LLM_API_KEY: 'test' });
  const poster: VoicePoster = { reply: async () => { throw new Error('No post expected'); } };
  const voice = new DiscordVoice(client, 'guild', config, poster, meter().usage, () => false);
  let tool!: ToolDefinition;
  voice.register({ register: (definition: ToolDefinition) => { tool = definition; } } as unknown as ToolRegistry);
  const context = { message: { author: 'user' }, isAdmin: false } as ToolContext;
  await assert.rejects(tool.execute(context, { action: 'join' }), /Join a server voice channel first/);
  assert.equal(await tool.execute(context, { action: 'status' }), 'No active voice session.');
  voice.stop(); assert.equal(client.listenerCount('voiceStateUpdate'), 0);
});

test('voice transport announces listening, joins undeafened, restricts leave, and cleans up on empty channel', async () => {
  const notices: unknown[] = [];
  const channel = { id: 'channel', type: ChannelType.GuildVoice, members: new Collection([['user', { user: { bot: false } }]]), permissionsFor: () => ({ has: () => true }), send: async (notice: unknown) => { notices.push(notice); } };
  const member = { voice: { channelId: channel.id, channel } };
  const guild = { id: 'guild', members: { fetch: async () => member, fetchMe: async () => ({}) }, channels: { cache: new Map([[channel.id, channel]]) } };
  const client = Object.assign(new EventEmitter(), { user: { id: 'bot' }, guilds: { fetch: async () => guild } }) as unknown as Client;
  let destroyed = false;
  const connection = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready }, receiver: { speaking: new EventEmitter() }, subscribe: () => {},
    destroy: () => { destroyed = true; connection.emit(VoiceConnectionStatus.Destroyed); },
  });
  const connect = ((options: Parameters<typeof joinVoiceChannel>[0]) => {
    assert.equal(notices.length, 1); assert.equal(options.selfDeaf, false); assert.equal(options.selfMute, false);
    return connection;
  }) as unknown as typeof joinVoiceChannel;
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test', LLM_API_KEY: 'test' });
  const poster: VoicePoster = { reply: async () => { throw new Error('No post expected'); } };
  const voice = new DiscordVoice(client, 'guild', config, poster, meter().usage, () => false, connect);
  let tool!: ToolDefinition;
  voice.register({ register: (definition: ToolDefinition) => { tool = definition; } } as unknown as ToolRegistry);
  const context = { message: { author: 'user' }, isAdmin: false } as ToolContext;
  try {
    assert.match(String(await tool.execute(context, { action: 'join' })), /Joined/);
    assert.match(String(await tool.execute(context, { action: 'join' })), /Already listening/);
    member.voice.channelId = 'elsewhere';
    await assert.rejects(tool.execute(context, { action: 'leave' }), /Join the active voice channel/);
    assert.equal(destroyed, false);
    channel.members.clear(); (client as EventEmitter).emit('voiceStateUpdate', {}, { guild, id: 'user' });
    assert.equal(destroyed, true);
    assert.equal(await tool.execute(context, { action: 'status' }), 'No active voice session.');
  } finally { voice.stop(); }
});
