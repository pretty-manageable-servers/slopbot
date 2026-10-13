import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { ChannelType, Collection, type Client } from 'discord.js';
import { VoiceConnectionStatus, type joinVoiceChannel } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { PmAudio, pcmWav, speechPcm } from '../src/adapters/audio.js';
import { DiscordVoice } from '../src/adapters/discord-voice.js';
import { VoiceConversation, type VoiceAudio } from '../src/voice-conversation.js';
import type { LLM } from '../src/ports.js';
import type { Prompt } from '../src/domain.js';
import { UsageMeter } from '../src/usage-meter.js';
import { UserLimiter } from '../src/user-limiter.js';
import type { ToolDefinition, ToolRegistry, ToolContext } from '../src/tools.js';
import { loadConfig } from '../src/config.js';

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

function fixture(limit = 1_000_000) {
  let spent = 0;
  const limiter = { check: async () => spent < limit ? { allowed: true as const } : { allowed: false as const, resetAt: 1 }, record: async (_user: string, cost: number) => { spent += cost; }, overGrace: async () => spent >= limit } as unknown as UserLimiter;
  const usage = new UsageMeter(limiter, () => ({}), { input: 0, output: 0, cached_input: 0 });
  const prompts: Prompt[] = [];
  const llm: LLM = { model: 'test', async *stream(prompt) { prompts.push(prompt); yield { kind: 'text', payload: { text: 'Hello back.' } }; yield { kind: 'usage', payload: { prompt_tokens: 1, completion_tokens: 1 } }; } };
  let transcriptions = 0, speeches = 0;
  const audio: VoiceAudio = { transcribe: async () => { transcriptions++; return 'Hello'; }, speak: async () => { speeches++; return Buffer.from('speech'); } };
  return { usage, llm, prompts, audio, spent: () => spent, calls: () => ({ transcriptions, speeches }) };
}

test('voice conversation keeps session history and charges audio to the speaker', async () => {
  const f = fixture(), session = new VoiceConversation(f.audio, f.llm, f.usage, 'guild');
  for (let index = 0; index < 8; index++) await session.reply('user', 'Human', Buffer.alloc(192000), new AbortController().signal);
  assert.equal(f.prompts[0]!.history.length, 0);
  assert.equal(f.prompts[7]!.history.length, 12);
  assert.equal(f.prompts[0]!.tools, undefined);
  assert.equal(f.spent(), 8 * (67 + 110));
});

test('blocked users make no audio calls; hitting the limit after STT stops the turn', async () => {
  const blocked = fixture(0);
  await new VoiceConversation(blocked.audio, blocked.llm, blocked.usage, 'guild').reply('user', 'Human', Buffer.alloc(192000), new AbortController().signal);
  assert.deepEqual(blocked.calls(), { transcriptions: 0, speeches: 0 });
  const capped = fixture(50);
  await new VoiceConversation(capped.audio, capped.llm, capped.usage, 'guild').reply('user', 'Human', Buffer.alloc(192000), new AbortController().signal);
  assert.deepEqual(capped.calls(), { transcriptions: 1, speeches: 0 });
  assert.equal(capped.prompts.length, 0);
});

test('leaving a session aborts generation before speech and does not keep a failed turn', async () => {
  const f = fixture(), abort = new AbortController();
  const llm: LLM = { async *stream() { abort.abort(); yield { kind: 'text', payload: { text: 'Cancelled' } }; } };
  await assert.rejects(new VoiceConversation(f.audio, llm, f.usage, 'guild').reply('user', 'Human', Buffer.alloc(192000), abort.signal));
  assert.equal(f.calls().speeches, 0);
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
  const f = fixture();
  const voice = new DiscordVoice(client, 'guild', config, f.llm, f.usage, () => false);
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
  const f = fixture(), config = loadConfig({ DISCORD_BOT_TOKEN: 'test', LLM_API_KEY: 'test' });
  const voice = new DiscordVoice(client, 'guild', config, f.llm, f.usage, () => false, connect);
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
