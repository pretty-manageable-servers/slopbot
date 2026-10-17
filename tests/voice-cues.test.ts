import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { ChannelType, Collection, type Client } from 'discord.js';
import { AudioPlayerStatus, VoiceConnectionStatus, type AudioPlayer, type joinVoiceChannel } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { DiscordVoice, voiceTurnSkipped, type VoicePoster } from '../src/adapters/discord-voice.js';

import { pcmWav } from '../src/adapters/audio.js';
import { liveText } from '../src/live-text.js';
import type { Message } from '../src/domain.js';
import { UsageMeter } from '../src/usage-meter.js';
import { UserLimiter } from '../src/user-limiter.js';
import type { ToolContext, ToolDefinition, ToolRegistry } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_VOICE_INSTRUCTIONS, VOICE_LIMIT_TEXT, VOICE_SKIP, VOICE_SPOKEN_MAX } from '../src/voice-rules.js';

/** Speech in these tests is loud (RMS about 8500). Cues are about 4100 RMS. Silence is 0. */
const SPEECH_LEVEL = 12000;
const FRAME_BYTES = 3840;

type PostInput = Parameters<VoicePoster['reply']>[0];

interface FakeMessage {
  id: string;
  content: string;
  deleted: boolean;
  /** Every emoji the bot added, in order. */
  reacted: string[];
  /** Every emoji the bot removed, in order. */
  removed: string[];
  reactions: { cache: Map<string, { users: { remove: () => Promise<void> } }> };
  react(emoji: string): Promise<void>;
  delete(): Promise<void>;
}

/** Waits for a condition by yielding to timers. Mock Date does not stop this. */
async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 2000; index++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('condition was not reached');
}

/** Lets pending async work finish, for checks that something did NOT happen. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await new Promise(resolve => setTimeout(resolve, 2));
}

/** A clock that only moves when the test says so. Make it before rig(), so the join's post uses it. */
function fakeClock(t: TestContext) {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  return { advance: (ms: number) => { now += ms; } };
}

function fakeMessage(chat: Map<string, FakeMessage>, id: string, content: string): FakeMessage {
  const message: FakeMessage = {
    id, content, deleted: false, reacted: [], removed: [],
    reactions: { cache: new Map() },
    async react(emoji) {
      message.reacted.push(emoji);
      message.reactions.cache.set(emoji, { users: { remove: async () => { message.removed.push(emoji); message.reactions.cache.delete(emoji); } } });
    },
    async delete() { message.deleted = true; chat.delete(id); },
  };
  chat.set(id, message);
  return message;
}

function meter(limit = 1_000_000) {
  let spent = 0;
  const limiter = { check: async () => spent < limit ? { allowed: true as const } : { allowed: false as const, resetAt: 1 }, record: async (_user: string, cost: number) => { spent += cost; }, overGrace: async () => spent >= limit } as unknown as UserLimiter;
  return new UsageMeter(limiter, () => ({}), { input: 0, output: 0, cached_input: 0 });
}

/**
 * A meter the test can put over the limit. `over` makes check() refuse and overGrace() true.
 * `grace` makes only overGrace() true, so a turn is dropped after its transcript. `recorded` holds every cost billed.
 */
function limitedMeter() {
  const state = { over: false, grace: false, recorded: [] as number[] };
  const limiter = {
    check: async () => state.over ? { allowed: false as const, resetAt: 1 } : { allowed: true as const },
    record: async (_user: string, cost: number) => { state.recorded.push(cost); },
    overGrace: async () => state.over || state.grace,
  } as unknown as UserLimiter;
  return { usage: new UsageMeter(limiter, () => ({}), { input: 0, output: 0, cached_input: 0 }), state };
}

/** One speech response: 200 ms of a loud 440 Hz tone, as SSE. */
function speechResponse(): Response {
  const encoder = new TextEncoder();
  const samples = 4800;
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) pcm.writeInt16LE(Math.round(SPEECH_LEVEL * Math.sin(2 * Math.PI * 440 * index / 24000)), index * 2);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'speech.audio.delta', audio: pcm.toString('base64') })}\n\n`));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  } });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** A 24 kHz mono WAV of 0.1 s, for the non-streamed speech of the cue clip. */
function wav24(): Buffer {
  const wav = pcmWav(Buffer.alloc(4800));
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
  return wav;
}

/** Replaces the AI provider. Transcripts return "Hello". Each speech request's input is recorded; streamed speech is SSE. */
function stubProvider(t: TestContext) {
  const speeches: string[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('transcriptions')) return Response.json({ text: 'Hello' });
    const body = JSON.parse(String(init?.body)) as { input: string; stream?: boolean };
    speeches.push(body.input);
    return body.stream === true ? speechResponse() : new Response(new Uint8Array(wav24()));
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  return speeches;
}

/**
 * A player for the tests. Each resource's PCM is decoded and kept, so the cue and speech kinds can be checked.
 * It emits 'idle' when a resource ends, as the real player does.
 */
class FakePlayer extends EventEmitter {
  state: { status: AudioPlayerStatus } = { status: AudioPlayerStatus.Idle };
  /** Decoded PCM of each resource, in play order. Complete once ended[index] is true. */
  readonly resources: Buffer[] = [];
  readonly ended: boolean[] = [];
  /** Play and end events in order, such as "play 0" and "end 0". */
  readonly events: string[] = [];
  play(resource: { playStream: Readable }): void {
    const index = this.resources.push(Buffer.alloc(0)) - 1;
    this.ended[index] = false;
    this.state = { status: AudioPlayerStatus.Playing };
    this.events.push(`play ${index}`);
    const codec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
    const chunks: Buffer[] = [];
    const stream = resource.playStream;
    stream.on('readable', () => { let packet: Buffer | null; while ((packet = stream.read()) !== null) chunks.push(Buffer.from(codec.decode(packet))); });
    stream.on('end', () => {
      codec.delete();
      this.resources[index] = Buffer.concat(chunks);
      this.ended[index] = true;
      this.events.push(`end ${index}`);
      this.state = { status: AudioPlayerStatus.Idle };
      this.emit(AudioPlayerStatus.Idle);
    });
  }
  stop(): void {}
  /** The kinds of sound in a resource, in order: "cue" or "speech". Short runs and silence are left out. */
  kinds(index: number): string[] {
    const pcm = this.resources[index]!;
    const labels: string[] = [];
    for (let offset = 0; offset + FRAME_BYTES <= pcm.length; offset += FRAME_BYTES) labels.push(loudness(pcm, offset));
    const out: string[] = [];
    for (let start = 0; start < labels.length;) {
      let end = start;
      while (end < labels.length && labels[end] === labels[start]) end++;
      const label = labels[start]!;
      // A boundary frame that mixes two sounds is one frame long, so runs of 2 frames or more decide.
      if (end - start >= 2 && label !== 'silence' && out.at(-1) !== label) out.push(label);
      start = end;
    }
    return out;
  }
}

/** One 20 ms frame of stereo PCM is a cue, speech or silence, by its RMS. */
function loudness(pcm: Buffer, offset: number): string {
  let squares = 0;
  for (let index = 0; index < FRAME_BYTES; index += 2) squares += pcm.readInt16LE(offset + index) ** 2;
  const rms = Math.sqrt(squares / (FRAME_BYTES / 2));
  return rms < 500 ? 'silence' : rms < 6000 ? 'cue' : 'speech';
}

const voiceMessage = { id: 'turn-message', server: 'guild', channel: 'channel', author: 'user', text: 'Hello', timestamp: 1, source: 'voice' } as unknown as Message;

/** Emits one reply run to the live feed: start, the text deltas, then end. */
function reply(runId: string, deltas: string[]): void {
  liveText.emit({ kind: 'start', message: voiceMessage, runId });
  for (const text of deltas) liveText.emit({ kind: 'text', message: voiceMessage, runId, text });
  liveText.emit({ kind: 'end', message: voiceMessage, runId, status: 'done' });
}

/** A joined voice session with fake Discord objects. One speaker, "user", is in the channel. */
async function rig(t: TestContext, options: { reply?: 'voice' | 'text'; usage?: UsageMeter } = {}) {
  const speeches = stubProvider(t);
  const usage = options.usage ?? meter();
  const chat = new Map<string, FakeMessage>();
  let made = 0;
  const posts: PostInput[] = [];
  const poster: VoicePoster = { reply: async input => {
    posts.push(input);
    const messageId = `transcript-${posts.length}`;
    fakeMessage(chat, messageId, input.text);
    return { id: `web-${posts.length}`, messageId, status: 'posted', via: 'bot' };
  } };
  const textChannel = {
    id: 'channel', type: ChannelType.GuildVoice, isTextBased: () => true, isSendable: () => true,
    members: new Collection([['user', { user: { bot: false } }]]), permissionsFor: () => ({ has: () => true }),
    send: async (input: { content?: string }) => fakeMessage(chat, `chat-${++made}`, input.content ?? ''),
    messages: { fetch: async (id: string) => { const message = chat.get(id); if (!message) throw new Error(`Unknown message ${id}`); return message; } },
  };
  const member = { user: { bot: false }, displayName: 'Human', voice: { channelId: 'channel', channel: textChannel } };
  // A second speaker, "other", is in the channel too. Used by the per-user limit test.
  const other = { user: { bot: false }, displayName: 'Other', voice: { channelId: 'channel', channel: textChannel } };
  const guild = { id: 'guild', members: { fetch: async () => member, fetchMe: async () => ({}), cache: new Map([['user', member], ['other', other]]) }, channels: { cache: new Map([['channel', textChannel]]) } };
  const client = Object.assign(new EventEmitter(), {
    user: { id: 'bot' },
    guilds: { fetch: async () => guild, cache: new Map([['guild', guild]]) },
    channels: { fetch: async (id: string) => (id === 'channel' ? textChannel : undefined) },
  }) as unknown as Client;
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
  const player = new FakePlayer();
  const voice = new DiscordVoice(client, 'guild', config, poster, usage, () => false, () => DEFAULT_VOICE_INSTRUCTIONS, async () => {}, connect, () => player as unknown as AudioPlayer);
  t.after(() => voice.stop());
  const tools = new Map<string, ToolDefinition>();
  voice.register({ register: (definition: ToolDefinition) => { tools.set(definition.name, definition); } } as unknown as ToolRegistry);
  const context = { message: { author: 'user' }, isAdmin: false } as unknown as ToolContext;
  await tools.get('voice')!.execute(context, options.reply ? { action: 'join', reply: options.reply } : { action: 'join' });
  // The speaker starts talking. The real speaking event passes the user ID.
  const talk = (user = 'user') => connection.receiver.speaking.emit('start', user);
  /** Runs the voice_skip tool as the model would, in the given message's context. */
  const skip = (message: Partial<Message>) => tools.get('voice_skip')!.execute({ message } as unknown as ToolContext, {});
  /** Runs the voice_say tool with `text`, in a voice message's context. */
  const say = (text: string, message: Partial<Message> = { source: 'voice', channel: 'channel' }) => tools.get('voice_say')!.execute({ message } as unknown as ToolContext, { text });
  return { voice, tools, context, speeches, chat, posts, player, talk, skip, say };
}


test('voice_skip tool marks the turn and suppresses the reply', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  const message = { source: 'voice', channel: 'channel' } as Partial<Message>;
  assert.equal(await r.skip(message), 'Skipped. Write no reply.');
  assert.equal(voiceTurnSkipped(voiceMessage), true);
  // reply() ends the turn with the skip marker. Nothing is spoken.
  await r.voice.speak('channel', VOICE_SKIP);
  await settle();
  assert.equal(r.speeches.length, 0);
  // The transcript's ear becomes a sleep. Nothing plays.
  const transcript = r.chat.get('transcript-1')!;
  assert.deepEqual(transcript.removed, ['👂']);
  assert.ok(transcript.reacted.includes('💤'));
  assert.equal(r.player.resources.length, 0);
  assert.equal(voiceTurnSkipped(voiceMessage), false);
});

test('voice_skip outside a voice turn does nothing', async t => {
  const r = await rig(t);
  // No turn yet.
  assert.equal(await r.skip({ source: 'voice', channel: 'channel' }), 'Nothing to skip.');
  r.talk();
  await until(() => r.posts.length === 1);
  // A message that did not come from voice is not skipped.
  assert.equal(await r.skip({ source: 'web', channel: 'channel' }), 'Nothing to skip.');
  await r.voice.speak('channel', 'Hello there.');
  // The turn was not skipped, so its reply was spoken.
  assert.deepEqual(r.speeches, ['Hello there.']);
});

test('voice_say speaks its text and the reply is not spoken', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  assert.equal(await r.say('Hello there.'), 'Speaking.');
  // The chat answer streams in and is posted. It is long, and it is not read aloud.
  reply('run-1', ['Here is the full answer with a link and details that stay in the chat. ']);
  await r.voice.speak('channel', 'Here is the full answer with a link and details that stay in the chat.');
  await until(() => r.player.ended[0] === true);
  assert.deepEqual(r.speeches, ['Hello there.']);
  assert.deepEqual(r.player.kinds(0), ['speech']);
});

test('voice_say stops at the spoken limit', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  const long = Array.from({ length: 100 }, (_, index) => `This is sentence number ${index + 1} of many.`).join(' ');
  await r.say(long);
  assert.equal(await r.say('One more line.'), 'Spoken limit reached. Nothing more is spoken in this turn.');
  await until(() => r.speeches.length > 0);
  await settle();
  const total = r.speeches.reduce((sum, text) => sum + Array.from(text).length, 0);
  assert.ok(total <= VOICE_SPOKEN_MAX, `spoken ${total} characters`);
});

test('voice_say in text mode speaks nothing', async t => {
  const r = await rig(t, { reply: 'text' });
  r.talk();
  await until(() => r.posts.length === 1);
  assert.equal(await r.say('Hello there.'), 'Text-only session; not spoken.');
  await r.voice.speak('channel', 'Hello there.');
  assert.equal(r.speeches.length, 0);
});

test('voice_skip beats voice_say', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  await r.skip({ source: 'voice', channel: 'channel' });
  assert.equal(await r.say('Hello there.'), 'Skipped. Nothing is spoken.');
  await r.voice.speak('channel', VOICE_SKIP);
  await settle();
  assert.equal(r.speeches.length, 0);
});

test('over the limit speaks the limit sentence once', async t => {
  const { usage, state } = limitedMeter();
  const r = await rig(t, { usage });
  // Over the limit: the turn is dropped before the transcript is made.
  state.over = true;
  r.talk();
  await until(() => r.player.ended[0] === true);
  await settle();
  assert.deepEqual(r.speeches, [VOICE_LIMIT_TEXT]);
  assert.deepEqual(r.player.events, ['play 0', 'end 0']);
  // No transcript is posted, and the turn ends so the next one can start.
  assert.deepEqual(r.posts, []);
  assert.match(String(await r.tools.get('voice')!.execute(r.context, { action: 'status' })), /State: Listening/);
});

test('limit sentence is not billed', async t => {
  const clock = fakeClock(t);
  const { usage, state } = limitedMeter();
  const r = await rig(t, { usage });
  // Over the limit before the transcript: nothing is billed for the sentence.
  state.over = true;
  r.talk();
  await until(() => r.player.ended[0] === true);
  await settle();
  assert.deepEqual(state.recorded, []);
  // Over the limit only after the transcript: the transcript is billed, the sentence is not.
  clock.advance(5 * 60_000);
  state.over = false;
  state.grace = true;
  r.talk();
  await until(() => r.player.ended[1] === true);
  await settle();
  assert.equal(state.recorded.length, 1);
  assert.notEqual(state.recorded[0], Array.from(VOICE_LIMIT_TEXT).length * 10);
  assert.deepEqual(r.speeches, [VOICE_LIMIT_TEXT]);
});
