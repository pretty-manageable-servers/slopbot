import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { ChannelType, Collection, type Client } from 'discord.js';
import { AudioPlayerStatus, VoiceConnectionStatus, type AudioPlayer, type joinVoiceChannel } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { DiscordVoice, voiceTurnSkipped, type VoicePoster } from '../src/adapters/discord-voice.js';
import { DiscordServer } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { pcmWav } from '../src/adapters/audio.js';
import { liveText } from '../src/live-text.js';
import type { Message } from '../src/domain.js';
import { UsageMeter } from '../src/usage-meter.js';
import { UserLimiter } from '../src/user-limiter.js';
import type { ToolContext, ToolDefinition, ToolRegistry } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import { HEARD_CUE, READY_CUE } from '../src/voice-sounds.js';
import { DEFAULT_VOICE_INSTRUCTIONS, VOICE_CUE_TEXT, VOICE_SKIP, containsSkipMarker, heldSkipLength, isErrorReply, spokenText } from '../src/voice-rules.js';

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
async function rig(t: TestContext, options: { reply?: 'voice' | 'text' } = {}) {
  const speeches = stubProvider(t);
  const usage = meter();
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
  const guild = { id: 'guild', members: { fetch: async () => member, fetchMe: async () => ({}), cache: new Map([['user', member]]) }, channels: { cache: new Map([['channel', textChannel]]) } };
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
  const talk = () => connection.receiver.speaking.emit('start', 'user');
  /** Runs the voice_skip tool as the model would, in the given message's context. */
  const skip = (message: Partial<Message>) => tools.get('voice_skip')!.execute({ message } as unknown as ToolContext, {});
  /** Runs the voice_say tool with `text`, in a voice message's context. */
  const say = (text: string, message: Partial<Message> = { source: 'voice', channel: 'channel' }) => tools.get('voice_say')!.execute({ message } as unknown as ToolContext, { text });
  return { voice, tools, context, speeches, chat, posts, player, talk, skip, say };
}

/** The "Listening" lines still in the chat. */
function listening(r: { chat: Map<string, FakeMessage> }): FakeMessage[] {
  return [...r.chat.values()].filter(message => !message.deleted && message.content.includes('Listening'));
}

test('heard cue plays first in the turn stream', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  await r.voice.speak('channel', 'Hello there.');
  await until(() => r.player.ended[0] === true);
  // The heard cue is the first audio of the turn's one stream. The reply follows in the same resource.
  assert.deepEqual(r.player.kinds(0), ['cue', 'speech']);
  assert.deepEqual(r.speeches, ['Hello there.']);
});

test('ready cue plays after the turn ends', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  await r.voice.speak('channel', 'Hello there.');
  await until(() => r.player.ended[1] === true);
  // The ready cue is its own resource, and it starts only after the reply has played.
  assert.deepEqual(r.player.events, ['play 0', 'end 0', 'play 1', 'end 1']);
  assert.deepEqual(r.player.kinds(1), ['cue']);
});

test('no ready cue on leave', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  r.voice.leave();
  await settle();
  // Only the heard cue played, in the turn's stream. Leaving does not add a ready cue.
  assert.equal(r.player.resources.length, 1);
});

test('text mode plays cues but no speech', async t => {
  const r = await rig(t, { reply: 'text' });
  r.talk();
  await until(() => r.posts.length === 1);
  await r.voice.speak('channel', 'Hello there.');
  await until(() => r.player.ended[1] === true);
  assert.equal(r.speeches.length, 0);
  // Text mode: the heard cue and the ready cue, each on its own resource.
  assert.deepEqual(r.player.kinds(0), ['cue']);
  assert.deepEqual(r.player.kinds(1), ['cue']);
});

test('transcript gets ear reaction', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  await until(() => r.chat.get('transcript-1')?.reacted.includes('👂') === true);
  assert.deepEqual(r.chat.get('transcript-1')!.reacted, ['👂']);
});

test('listening line is posted and the previous one deleted', async t => {
  const clock = fakeClock(t);
  const r = await rig(t);
  // Posted once the join is ready.
  await until(() => listening(r).length === 1);
  const first = listening(r)[0]!;
  clock.advance(5000);
  r.talk();
  await until(() => r.posts.length === 1);
  await r.voice.speak('channel', 'Hello there.');
  await until(() => listening(r).length === 1 && listening(r)[0] !== first);
  assert.equal(first.deleted, true);
});

test('listening line is rate limited', async t => {
  const clock = fakeClock(t);
  const r = await rig(t);
  await until(() => listening(r).length === 1);
  const first = listening(r)[0]!;
  // A turn that ends 1 s after the line was posted does not post again. The line stays.
  clock.advance(1000);
  r.talk();
  await until(() => r.posts.length === 1);
  await r.voice.speak('channel', 'Hello there.');
  await settle();
  assert.deepEqual(listening(r), [first]);
  assert.equal(first.deleted, false);
  // After the 3 s window, the next turn posts a new line and deletes the old one.
  clock.advance(3000);
  r.talk();
  await until(() => r.posts.length === 2);
  await r.voice.speak('channel', 'Again.');
  await until(() => listening(r).length === 1 && listening(r)[0] !== first);
  assert.equal(first.deleted, true);
});

test('voice_skip tool marks the turn and suppresses the reply', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  const message = { source: 'voice', channel: 'channel' } as Partial<Message>;
  assert.equal(await r.skip(message), 'Skipped. Write no reply.');
  assert.equal(voiceTurnSkipped(voiceMessage), true);
  // reply() ends the turn with the skip marker. Nothing is spoken.
  await r.voice.speak('channel', VOICE_SKIP);
  await until(() => r.player.ended[1] === true);
  assert.equal(r.speeches.length, 0);
  // The transcript's ear becomes a sleep, and the ready cue plays.
  const transcript = r.chat.get('transcript-1')!;
  assert.deepEqual(transcript.removed, ['👂']);
  assert.ok(transcript.reacted.includes('💤'));
  assert.deepEqual(r.player.kinds(1), ['cue']);
  assert.equal(voiceTurnSkipped(voiceMessage), false);
});

test('text after voice_skip is not spoken', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  await r.skip({ source: 'voice', channel: 'channel' });
  // The model writes text after the tool call. None of it is spoken.
  reply('run-1', ['Sure, here is a long answer that must not be read aloud. ']);
  await r.voice.speak('channel', VOICE_SKIP);
  await until(() => r.player.ended[1] === true);
  assert.equal(r.speeches.length, 0);
});

test('[SKIP] text fallback still suppresses', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  reply('run-1', ['[SKIP]']);
  await r.voice.speak('channel', '[SKIP]');
  await until(() => r.player.ended[1] === true);
  // No speech, and no error sentence either.
  assert.equal(r.speeches.length, 0);
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

test('[SKIP] in the middle of a reply suppresses it', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  // The marker is split across two deltas. It is held back until it is known.
  liveText.emit({ kind: 'start', message: voiceMessage, runId: 'run-1' });
  liveText.emit({ kind: 'text', message: voiceMessage, runId: 'run-1', text: 'Hi there, how are you doing today[SK' });
  liveText.emit({ kind: 'text', message: voiceMessage, runId: 'run-1', text: 'IP] and more text here. ' });
  liveText.emit({ kind: 'end', message: voiceMessage, runId: 'run-1', status: 'done' });
  await r.voice.speak('channel', 'Hi there, how are you doing today[SKIP] and more text here.');
  await until(() => r.player.ended[1] === true);
  assert.equal(r.speeches.length, 0);
});

test('skip reply posts nothing and ends the turn', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let sends = 0;
  const permissions = { has: () => true };
  const bot = '1514413259522838528', guild = '1528063444874432734', channel = '1528064977913647236';
  const sent = { id: 'reply', guildId: guild, channelId: channel, content: '', author: { id: bot, username: 'slopbot', bot: true }, attachments: new Map(), embeds: [], reference: null, mentions: { users: new Map() }, member: null, guild: { name: 'Server' }, createdTimestamp: 1, editedTimestamp: null };
  const target = { type: ChannelType.GuildText, guildId: guild, isThread: () => false, isTextBased: () => true, isSendable: () => true, send: async () => { sends++; return sent; }, permissionsFor: () => permissions, messages: { fetch: async () => undefined } };
  const client = Object.assign(new EventEmitter(), { user: { id: bot }, channels: { fetch: async () => target }, guilds: { fetch: async () => ({ members: { fetch: async () => ({ permissions }), fetchMe: async () => ({ permissions }) } }) } });
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test-only', DISCORD_GUILD_ID: guild, DISCORD_CHANNEL_IDS: channel, LLM_MODE: 'mock' });
  const adapter = new DiscordServer(config, store, { async *stream() { yield { kind: 'text', payload: { text: 'Hello.' } }; } } as never, client as unknown as Client, guild, undefined);
  const spoken: unknown[][] = [];
  Object.assign(adapter, { voice: { speak: async (...args: unknown[]) => { spoken.push(args); }, cue: async () => {}, stop: () => {} } });
  const request = { ...voiceMessage, server: guild, channel, id: 'request' } as Message;
  await adapter.reply(request, '[SKIP]');
  // No chat post, and the turn ends with the skip marker.
  assert.equal(sends, 0);
  assert.deepEqual(spoken, [[channel, VOICE_SKIP]]);
  // A normal voice reply is still posted.
  await adapter.reply(request, 'Hello there.');
  assert.equal(sends, 1);
});

test('skip is not spoken and not treated as error', () => {
  assert.equal(containsSkipMarker('[SKIP]'), true);
  assert.equal(containsSkipMarker('Sure \\[skip\\] now'), true);
  assert.equal(isErrorReply('[SKIP]'), false);
  assert.equal(spokenText('[SKIP]'), '');
  assert.equal(spokenText('[ACTION_UNCERTAIN] nope'), 'Sorry, that did not work. The details are in the chat.');
  // A held prefix waits for the next text. Plain text is not held.
  assert.equal(heldSkipLength('Hello ['), 1);
  assert.equal(heldSkipLength('Hello \\[S'), 3);
  assert.equal(heldSkipLength('Hello'), 0);
});

test('cue pcm is 48k stereo with fades', () => {
  // 48 kHz: 90 ms is 4320 frames, and 30 ms is 1440. Stereo 16-bit is 4 bytes per frame.
  assert.equal(HEARD_CUE.length, 4320 * 4);
  assert.equal(READY_CUE.length, (4320 + 1440 + 4320) * 4);
  for (const cue of [HEARD_CUE, READY_CUE]) {
    const frames = cue.length / 4;
    let peak = 0;
    for (let frame = 0; frame < frames; frame++) {
      const left = cue.readInt16LE(frame * 4), right = cue.readInt16LE(frame * 4 + 2);
      assert.equal(left, right, `frame ${frame} is not centred`);
      peak = Math.max(peak, Math.abs(left));
    }
    // The first and last samples are at zero, so there is no click at the edges.
    assert.ok(Math.abs(cue.readInt16LE(0)) < 10);
    assert.ok(Math.abs(cue.readInt16LE(cue.length - 4)) < 10);
    // About 0.18 of full scale.
    assert.ok(peak > 0.15 * 32767 && peak <= 0.19 * 32767, `peak ${peak}`);
  }
});

test('status shows Busy while a turn runs and Listening after it', async t => {
  const r = await rig(t);
  const status = () => r.tools.get('voice')!.execute(r.context, { action: 'status' });
  assert.match(String(await status()), /State: Listening/);
  r.talk();
  await until(() => r.posts.length === 1);
  assert.match(String(await status()), /State: Busy \(replying to Human\)/);
  await r.voice.speak('channel', 'Hello there.');
  assert.match(String(await status()), /State: Listening/);
});

test('voice_say speaks its text and the reply is not spoken', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  assert.equal(await r.say('Hello there.'), 'Speaking.');
  // The chat answer streams in and is posted. It is long, and it is not read aloud.
  reply('run-1', ['Here is the full answer with a link and details that stay in the chat. ']);
  await r.voice.speak('channel', 'Here is the full answer with a link and details that stay in the chat.');
  await until(() => r.player.ended[1] === true);
  assert.deepEqual(r.speeches, ['Hello there.']);
  assert.deepEqual(r.player.kinds(0), ['cue', 'speech']);
  assert.deepEqual(r.player.kinds(1), ['cue']);
});

test('voice_say starts speech before the reply is posted', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  assert.equal(await r.say('Hello there.'), 'Speaking.');
  // The speech request goes out with no reply and no speak() call.
  await until(() => r.speeches.includes('Hello there.'));
  await until(() => r.player.events.includes('play 0'));
  assert.deepEqual(r.speeches, ['Hello there.']);
});

test('no voice_say falls back to streaming the reply', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  reply('run-1', ['First sentence is here. Second sentence is here too.']);
  await r.voice.speak('channel', 'First sentence is here. Second sentence is here too.');
  assert.deepEqual(r.speeches, ['First sentence is here.', 'Second sentence is here too.']);
});

test('voice_say does not play the one moment cue', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  await r.say('Hello there.');
  // The progress post for voice_say calls cue(). The cue must not speak.
  await r.voice.cue('channel');
  await settle();
  assert.deepEqual(r.speeches, ['Hello there.']);
  await r.voice.speak('channel', 'Hello there.');
  // Another tool in a later turn still gets the cue.
  r.talk();
  await until(() => r.posts.length === 2);
  await r.voice.cue('channel');
  assert.ok(r.speeches.includes(VOICE_CUE_TEXT));
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
  await until(() => r.player.ended[1] === true);
  assert.equal(r.speeches.length, 0);
});
