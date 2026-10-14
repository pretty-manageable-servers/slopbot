import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { ChannelType, Collection, type Client } from 'discord.js';
import { VoiceConnectionStatus, type AudioPlayer, type joinVoiceChannel } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { PmAudio, pcmWav, speechPcm } from '../src/adapters/audio.js';
import { DiscordVoice, type VoicePoster } from '../src/adapters/discord-voice.js';
import { liveText } from '../src/live-text.js';
import type { Message } from '../src/domain.js';
import { UsageMeter } from '../src/usage-meter.js';
import { UserLimiter } from '../src/user-limiter.js';
import type { ToolDefinition, ToolRegistry, ToolContext } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_VOICE_INSTRUCTIONS, SentenceSplitter, VOICE_CUE_TEXT, VOICE_ERROR_TEXT, VOICE_SPOKEN_MAX, spokenText } from '../src/voice-rules.js';

/** Samples per sentence of fake speech: 2400 at 24 kHz is 0.1 s. */
const SAMPLES = 2400;
/**
 * Each sentence's speech is a 440 Hz tone. Its amplitude is LEVEL times the sentence's level (1, 2 or 3).
 * A sine has an RMS of amplitude / sqrt(2), so the player reads a level back as round(RMS / (LEVEL / sqrt 2)).
 */
const LEVEL = 4000;

/** A 24 kHz mono WAV: a 440 Hz tone of amplitude `amplitude`. */
function wav24(amplitude: number, samples = SAMPLES): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 440 * index / 24000)), index * 2);
  const wav = pcmWav(pcm);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
  return wav;
}

/** A speech response with two SSE deltas of `value` samples, then [DONE]. If `hang`, the stream stays open until the request aborts. */
function sseResponse(value: number, signal?: AbortSignal, hang = false): Response {
  const encoder = new TextEncoder();
  // The gateway sends 24 kHz mono samples. Discord's conversion happens in speakStream.
  const pcm = wav24(value).subarray(44);
  const half = pcm.length / 2;
  const deltas = [pcm.subarray(0, half), pcm.subarray(half)];
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const delta of deltas) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'speech.audio.delta', audio: delta.toString('base64') })}\n\n`));
    if (hang) { signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true }); return; }
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  } });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/**
 * A player that records the Opus packets of each resource. The real player is not used.
 * The bot's resource encodes its PCM to Opus, so levels() decodes the packets to read each sentence's level.
 */
class FakePlayer extends EventEmitter {
  readonly resources: Buffer[][] = [];
  readonly ended: boolean[] = [];
  stopped = false;
  play(resource: { playStream: Readable }): void {
    const packets: Buffer[] = [];
    const index = this.resources.push(packets) - 1;
    this.ended[index] = false;
    const stream = resource.playStream;
    stream.on('readable', () => { let packet: Buffer | null; while ((packet = stream.read()) !== null) packets.push(packet); });
    stream.on('end', () => { this.ended[index] = true; });
  }
  stop(): void { this.stopped = true; }
  packets(): number { return this.resources.reduce((sum, packets) => sum + packets.length, 0); }
  /** The sentence levels (1, 2, 3) in playing order, with repeats removed. Silence is not listed. */
  levels(): number[] {
    const codec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
    const out: number[] = [];
    let last = -1, run = 0;
    try {
      for (const packet of this.resources.flat()) {
        const pcm = Buffer.from(codec.decode(packet));
        let squares = 0;
        for (let offset = 0; offset + 2 <= pcm.length; offset += 4) squares += pcm.readInt16LE(offset) ** 2;
        const rms = Math.sqrt(squares / (pcm.length / 4));
        const level = Math.round(rms / (LEVEL / Math.SQRT2));
        // A frame that is part sentence and part silence reads as a lower level. Count a level only after 2 frames in a row.
        run = level === last ? run + 1 : 1; last = level;
        if (level !== 0 && run === 2 && out.at(-1) !== level) out.push(level);
      }
    } finally { codec.delete(); }
    return out;
  }
}

type PostInput = Parameters<VoicePoster['reply']>[0];

/** Waits for a condition by yielding to the event loop. It uses no timers. */
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

function meter(limit = 1_000_000) {
  let spent = 0;
  const limiter = { check: async () => spent < limit ? { allowed: true as const } : { allowed: false as const, resetAt: 1 }, record: async (_user: string, cost: number) => { spent += cost; }, overGrace: async () => spent >= limit } as unknown as UserLimiter;
  return { usage: new UsageMeter(limiter, () => ({}), { input: 0, output: 0, cached_input: 0 }), spent: () => spent };
}

interface SpeechCall { input: string; stream: boolean; at: number; signal: AbortSignal }

/**
 * Replaces the AI provider. Transcripts return `transcript`. Speech with stream:true is SSE; other speech is WAV.
 * Each speech request gets its own marker value (1, 2, 3 ...), so the played order can be checked.
 */
function stubProvider(t: TestContext, transcript: string, hang = false) {
  const calls = { transcriptions: 0, speeches: [] as SpeechCall[] };
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('transcriptions')) { calls.transcriptions++; return Response.json({ text: transcript }); }
    const body = JSON.parse(String(init?.body)) as { input: string; stream?: boolean };
    const value = (calls.speeches.length % 3 + 1) * LEVEL;
    calls.speeches.push({ input: body.input, stream: body.stream === true, at: Date.now(), signal: init!.signal! });
    if (body.stream) return sseResponse(value, init?.signal ?? undefined, hang);
    return new Response(new Uint8Array(wav24(value)));
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  return calls;
}

const message = { id: 'turn-message', server: 'guild', channel: 'channel', author: 'user', text: 'Hello', timestamp: 1, source: 'voice' } as unknown as Message;

/** Emits one reply run to the live feed: start, the text deltas, then end. */
function reply(runId: string, deltas: string[], status: 'done' | 'failed' = 'done'): void {
  liveText.emit({ kind: 'start', message, runId });
  for (const text of deltas) liveText.emit({ kind: 'text', message, runId, text });
  liveText.emit({ kind: 'end', message, runId, status });
}

/** A joined voice session with fake Discord objects. One speaker, `user`, is in the channel. */
async function rig(t: TestContext, options: { transcript?: string; reply?: 'voice' | 'text'; hang?: boolean } = {}) {
  const provider = stubProvider(t, options.transcript ?? 'Hello', options.hang);
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
  const player = new FakePlayer();
  const voice = new DiscordVoice(client, 'guild', config, poster, usage, () => false, () => DEFAULT_VOICE_INSTRUCTIONS, async () => {}, connect, () => player as unknown as AudioPlayer);
  t.after(() => voice.stop());
  let tool!: ToolDefinition;
  voice.register({ register: (definition: ToolDefinition) => { tool = definition; } } as unknown as ToolRegistry);
  const context = { message: { author: 'user' }, isAdmin: false } as ToolContext;
  const joined = await tool.execute(context, options.reply ? { action: 'join', reply: options.reply } : { action: 'join' });
  // The speaker starts talking. The real speaking event passes the user ID.
  const talk = () => connection.receiver.speaking.emit('start', 'user');
  return { voice, tool, context, joined, provider, posts, notices, spent, talk, player };
}

test('splitter splits sentences and keeps abbreviations', () => {
  const text = 'Dr. Smith uses e.g. green apples and 3.5 kilos of fruit each week. Is it really that much fruit? Yes, it is a lot of fruit!\nA new line starts here and goes on.';
  const expected = ['Dr. Smith uses e.g. green apples and 3.5 kilos of fruit each week.', 'Is it really that much fruit?', 'Yes, it is a lot of fruit!', 'A new line starts here and goes on.'];
  const whole = new SentenceSplitter();
  assert.deepEqual([...whole.push(text), ...whole.flush()], expected);
  // The same text in one-character deltas gives the same sentences.
  const pieces = new SentenceSplitter();
  const sentences: string[] = [];
  for (const character of text) sentences.push(...pieces.push(character));
  sentences.push(...pieces.flush());
  assert.deepEqual(sentences, expected);
  // A sentence waits for the whitespace after its mark, so a split "2." never ends one early.
  const waiting = new SentenceSplitter();
  assert.deepEqual(waiting.push('This is the first long sentence here.'), []);
  assert.deepEqual(waiting.push(' Then the next one starts'), ['This is the first long sentence here.']);
});

test('splitter merges short pieces', () => {
  const splitter = new SentenceSplitter();
  // "Yes." is under 20 characters, so it joins the next sentence.
  assert.deepEqual(splitter.push('Yes. It is a long enough sentence here. Ok. Fine by me, thanks a lot.'), ['Yes. It is a long enough sentence here.']);
  // flush() does not join: the last piece is returned as it is.
  assert.deepEqual(splitter.flush(), ['Ok. Fine by me, thanks a lot.']);
  // A short piece with nothing after it is returned at flush.
  const short = new SentenceSplitter();
  assert.deepEqual(short.push('Ok. '), []);
  assert.deepEqual(short.flush(), ['Ok.']);
});

test('speakStream parses split SSE lines and odd bytes', async () => {
  const values = [1, -2, 300];
  const pcm = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => pcm.writeInt16LE(value, index * 2));
  // Two deltas split one sample across them: the first holds 3 bytes, the second 3 bytes.
  const deltas = [pcm.subarray(0, 3), pcm.subarray(3)];
  const lines = [
    `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: deltas[0]!.toString('base64') })}\r\n`,
    ': keep-alive\n',
    `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: deltas[1]!.toString('base64') })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  // Send the text in chunks of 7 characters, so lines break across reads.
  const chunks = Array.from({ length: Math.ceil(lines.length / 7) }, (_, index) => lines.slice(index * 7, index * 7 + 7));
  const encoder = new TextEncoder();
  const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  const audio = new PmAudio('https://example.com', 'test', 'alloy', fetcher);
  const parts: Buffer[] = [];
  for await (const part of audio.speakStream('Hello there.', new AbortController().signal)) parts.push(part);
  assert.deepEqual(Buffer.concat(parts), expectedPcm(values));
});

/** The Discord PCM for 24 kHz samples, made by the same conversion as a WAV reply. */
function expectedPcm(values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => data.writeInt16LE(value, index * 2));
  const wav = pcmWav(data);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
  return speechPcm(wav);
}

test('speakStream falls back to WAV', async () => {
  const wav = wav24(7, 480);
  const fetcher: typeof fetch = async () => new Response(new Uint8Array(wav), { headers: { 'content-type': 'audio/wav' } });
  const audio = new PmAudio('https://example.com', 'test', 'alloy', fetcher);
  const parts: Buffer[] = [];
  for await (const part of audio.speakStream('Hello there.', new AbortController().signal)) parts.push(part);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], speechPcm(wav));
});

test('streamed sentences play in order before reply arrives', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  // Two sentences arrive. The first two requests go out and play, before the reply is complete.
  liveText.emit({ kind: 'start', message, runId: 'run-1' });
  liveText.emit({ kind: 'text', message, runId: 'run-1', text: 'First sentence is here. Second sentence is here too. ' });
  await until(() => r.provider.speeches.length === 2 && r.player.packets() >= 5);
  assert.equal(r.provider.speeches.every(call => call.stream), true);
  // The rest of the reply and the end.
  liveText.emit({ kind: 'text', message, runId: 'run-1', text: 'Third one ends it.' });
  liveText.emit({ kind: 'end', message, runId: 'run-1', status: 'done' });
  await r.voice.speak('channel', 'First sentence is here. Second sentence is here too. Third one ends it.');
  assert.deepEqual(r.provider.speeches.map(call => call.input), ['First sentence is here.', 'Second sentence is here too.', 'Third one ends it.']);
  assert.deepEqual(r.player.levels(), [1, 2, 3]);
  // One resource plays the whole turn, with no gap between sentences. The ready cue is a second resource, after the turn.
  assert.equal(r.player.resources.length, 2);
});

test('reply after streaming does not speak twice', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  reply('run-1', ['First sentence is here. ', 'Second sentence is here too.']);
  await r.voice.speak('channel', 'First sentence is here. Second sentence is here too.');
  assert.deepEqual(r.provider.speeches.map(call => call.input), ['First sentence is here.', 'Second sentence is here too.']);
  // The turn is over, so the next speech is accepted.
  r.talk();
  await until(() => r.posts.length === 2);
});

test('error reply falls back to error sentence', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  const error = '[PROVIDER_HTTP_404] AI provider returned HTTP 404';
  reply('run-1', [error], 'failed');
  await settle();
  assert.equal(r.provider.speeches.length, 0);
  await r.voice.speak('channel', error);
  assert.deepEqual(r.provider.speeches.map(call => call.input), [VOICE_ERROR_TEXT]);
  assert.equal(spokenText(error), VOICE_ERROR_TEXT);
});

test('spoken total capped at 600', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  const sentences = Array.from({ length: 40 }, (_, index) => `This is sentence number ${index + 1}, and it has some words in it.`);
  const text = sentences.join(' ');
  reply('run-1', [text]);
  await r.voice.speak('channel', text);
  const total = r.provider.speeches.reduce((sum, call) => sum + Array.from(call.input).length, 0);
  assert.ok(total <= VOICE_SPOKEN_MAX, `spoken ${total} characters`);
  assert.ok(total >= VOICE_SPOKEN_MAX - 80, `spoken ${total} characters`);
  assert.ok(r.provider.speeches.length < sentences.length);
  // The last request holds the start of its sentence, cut at the cap.
  const last = r.provider.speeches.length - 1;
  assert.ok(sentences[last]!.startsWith(r.provider.speeches[last]!.input));
});

test('pipeline keeps at most one request ahead', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  const text = 'Sentence one is here. Sentence two is here. Sentence three is here. Sentence four is here. Sentence five is here.';
  reply('run-1', [text]);
  await r.voice.speak('channel', text);
  const starts = r.provider.speeches.map(call => call.at);
  assert.equal(starts.length, 5);
  // The heard cue is the first job of the turn, so sentence 2 waits for the cue to play (0.09 s).
  // Sentence 3 waits until sentence 1 has played.
  assert.ok(starts[2]! - starts[0]! >= 90, `third request started after ${starts[2]! - starts[0]!} ms`);
  assert.ok(starts[3]! - starts[1]! >= 90, `fourth request started after ${starts[3]! - starts[1]!} ms`);
});

test('leave aborts streaming', async t => {
  const r = await rig(t, { hang: true });
  r.talk();
  await until(() => r.posts.length === 1);
  liveText.emit({ kind: 'start', message, runId: 'run-1' });
  liveText.emit({ kind: 'text', message, runId: 'run-1', text: 'This sentence starts and never finishes. ' });
  await until(() => r.provider.speeches.length === 1);
  const signal = r.provider.speeches[0]!.signal;
  assert.equal(signal.aborted, false);
  r.voice.leave();
  assert.equal(signal.aborted, true);
  assert.equal(r.player.stopped, true);
  await until(() => r.player.ended.every(ended => ended));
  // No more requests after leave.
  liveText.emit({ kind: 'text', message, runId: 'run-1', text: 'Another sentence after leaving here. ' });
  liveText.emit({ kind: 'end', message, runId: 'run-1', status: 'done' });
  await settle();
  assert.equal(r.provider.speeches.length, 1);
});

test('text mode posts transcript and plays no speech', async t => {
  const r = await rig(t, { reply: 'text' });
  r.talk();
  await until(() => r.posts.length === 1);
  assert.deepEqual(r.posts[0], { user: 'user', server: 'guild', channel: 'channel', text: 'Hello', kind: 'voice' });
  await r.voice.cue('channel');
  reply('run-1', ['First sentence is here. Second sentence is here too.']);
  await settle();
  assert.equal(r.provider.speeches.length, 0);
  // Only the heard cue plays: text mode has no reply speech.
  assert.equal(r.player.resources.length, 1);
  assert.match(String(r.joined), /text only/);
});

test('text mode ends turn when reply is posted', async t => {
  const r = await rig(t, { reply: 'text' });
  r.talk();
  await until(() => r.posts.length === 1);
  await r.voice.speak('channel', 'Hi there.');
  assert.equal(r.provider.speeches.length, 0);
  // The turn is over, so the next speech is accepted.
  r.talk();
  await until(() => r.posts.length === 2);
});

test('text mode skips cue and thunder billing', async t => {
  const r = await rig(t, { reply: 'text' });
  r.talk();
  await until(() => r.posts.length === 1);
  await r.voice.cue('channel');
  await settle();
  assert.equal(r.provider.speeches.length, 0);
  // Only the Squall transcription is billed. The 30720 bytes of speech are 0.16 s of audio at 4000 per minute.
  assert.equal(r.spent(), Math.ceil(30720 / 192000 / 60 * 4000));
});

test('status shows reply mode', async t => {
  const voice = await rig(t);
  assert.equal(await voice.tool.execute(voice.context, { action: 'status' }), `Voice session in <#channel>.\nReplies: voice\nState: Listening\nVoice style: ${DEFAULT_VOICE_INSTRUCTIONS}`);
  const text = await rig(t, { reply: 'text' });
  assert.equal(await text.tool.execute(text.context, { action: 'status' }), `Voice session in <#channel>.\nReplies: text\nState: Listening\nVoice style: ${DEFAULT_VOICE_INSTRUCTIONS}`);
});

test('voice mode cue plays before sentences in the same stream', async t => {
  const r = await rig(t);
  r.talk();
  await until(() => r.posts.length === 1);
  await r.voice.cue('channel');
  reply('run-1', ['First sentence is here. Second sentence is here too.']);
  await r.voice.speak('channel', 'First sentence is here. Second sentence is here too.');
  assert.deepEqual(r.provider.speeches.map(call => call.input), [VOICE_CUE_TEXT, 'First sentence is here.', 'Second sentence is here too.']);
  assert.deepEqual(r.player.levels(), [1, 2, 3]);
});
