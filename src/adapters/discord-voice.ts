import { Readable } from 'node:stream';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import OpusScript from 'opusscript';
import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Events, MessageFlags, PermissionFlagsBits, type ButtonInteraction, type Client } from 'discord.js';
import { AudioPlayerStatus, EndBehaviorType, NoSubscriberBehavior, StreamType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, type AudioPlayer, type AudioReceiveStream, type VoiceConnection } from '@discordjs/voice';
import type { Config } from '../config.js';
import { ToolError, type ToolRegistry } from '../tools.js';
import type { Message } from '../domain.js';
import { errorReply, logError } from '../errors.js';
import type { UsageMeter } from '../usage-meter.js';
import type { WebReplies } from '../web-replies.js';
import { containsSkipMarker, cutSpoken, heldSkipLength, isErrorReply, plainSpoken, SentenceSplitter, splitSpeak, spokenText, VOICE_FILLER_GAP_MS, VOICE_FILLER_MAX, VOICE_FILLER_TEXTS, VOICE_INSTRUCTIONS_MAX, VOICE_SPOKEN_MAX, VOICE_TURN_TIMEOUT_MS } from '../voice-rules.js';
import { liveText, type LiveTextEvent } from '../live-text.js';
import { PmAudio, speechPcm } from './audio.js';

const MAX_AUDIO_BYTES = 30 * 192000;
const IDLE_MS = 5 * 60_000;
const PROPOSAL_MS = 15 * 60_000;
const PREVIEW_TEXT = 'Hi, this is my new voice.';
/** Voice channels whose live turn is skipped. A channel ID is unique in Discord, so one set serves every server. */
const skippedChannels = new Set<string>();

/** True while the live voice turn in the message's channel is skipped. reply() then posts nothing for it. */
export function voiceTurnSkipped(message: Message): boolean {
  return message.source === 'voice' && skippedChannels.has(message.channel);
}

/** The chat line that tells users Slopbot is listening. At most one per session, posted at most once per window. */
const LISTENING_LINE = '-# 🎙️ Listening';
const LISTENING_GAP_MS = 3000;
/** Reactions on a transcript: 👂 while it is handled, 💤 when the turn is skipped. */
const EAR = '👂', SLEEP = '💤';

/** A voice description drafted by the model, waiting for a server admin to apply it. */
interface Proposal { instructions: string; proposer: string; expiresAt: number }

/** "default" or empty means no server setting. Throws when the text is too long. */
function styleText(raw: string): string {
  const text = raw.trim();
  if (text.toLowerCase() === 'default') return '';
  if (Array.from(text).length > VOICE_INSTRUCTIONS_MAX) throw new ToolError(`Voice instructions must be ${VOICE_INSTRUCTIONS_MAX} characters or fewer.`);
  return text;
}

function previewFile(wav: Buffer): AttachmentBuilder { return new AttachmentBuilder(wav, { name: 'voice-preview.wav' }); }

/** Posts a transcript into the voice channel's chat. The normal bot path then answers it. */
export interface VoicePoster { reply: WebReplies["reply"] }

/** One speaker's turn. It starts at capture and ends after the spoken reply, a timeout, or an early stop. */
interface Turn {
  user: string;
  /** True once voice_say queued spoken text. The reply text is then not read aloud. voice_say may be called again. */
  said: boolean;
  channel: string;
  timer: ReturnType<typeof setTimeout>;
  /** Checks for a long silence while the bot works, and then speaks a filler. Started when the transcript is posted. */
  filler?: ReturnType<typeof setInterval>;
  /** Fillers spoken in this turn. */
  fillers: number;
  /** Time (ms since epoch) the silence counts from, before any audio plays. */
  quietFrom: number;
  /** WP1: true when the voice tool's leave ran in this turn. The session leaves after the reply has finished playing. */
  leaveAfter: boolean;
  /** WP2: true when a tool other than voice_say or voice_skip started after the last voice_say. */
  toolAfterSay: boolean;
  /** True once the model skipped the turn (voice_skip, or a [SKIP] marker). Its speech stops and is not started again. */
  skipped: boolean;
  /** The chat message that holds the transcript, once it is posted. Its reactions show the turn state. */
  transcript?: { channel: string; messageId: string };
  speech: TurnSpeech;
}

/** One reply run's text, read as it streams. `mode` decides once whether the reply is read aloud. `raw` is all the text seen. */
interface RunState { turn: Turn; splitter: SentenceSplitter; head: string; held: string; raw: string; mode: 'undecided' | 'stream' | 'skip' }

interface Session {
  channel: string;
  connection: VoiceConnection;
  abort: AbortController;
  player: AudioPlayer;
  audio: PmAudio;
  busy: boolean;
  /** 'voice' reads replies aloud. 'text' only captures speech and posts transcripts. */
  replies: 'voice' | 'text';
  /** WP3: the text channel where the join was asked. Task threads of voice requests open here. Undefined when there is none. */
  origin: string | undefined;
  turn: Turn | undefined;
  /** Message ID of the "Listening" line in the voice channel chat, if one is up. */
  listening: string | undefined;
  /** Time (ms since epoch) of the last "Listening" post. */
  listeningAt: number;
  /** Filler clips by text, for one set of voice instructions. Made again when the instructions change. */
  fillers: { instructions: string; clips: Map<string, Promise<Buffer>> } | undefined;
  refresh(): void;
  fail(error: unknown): void;
  stop(): void;
}

/** Discord playback PCM: 48 kHz, 2 channels, 16 bit. That is 192 bytes per millisecond. */
const PCM_BYTES_PER_MS = 192;

/** Resolves at `time` (ms since epoch), or at once when `signal` aborts. */
function sleepUntil(time: number, signal: AbortSignal): Promise<void> {
  const wait = time - Date.now();
  if (wait <= 0 || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, wait);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** 48 kHz stereo 16-bit is 192 bytes per ms. Thunder's first chunks double in size (80, 160, 320, 640 ms), so about 700 ms must be buffered to play without gaps. */
const START_BUFFER_BYTES = 750 * 192;
const REBUFFER_BYTES = 500 * 192;
/** The Discord player stops after this many 20 ms frames with no data (its default is 5). A reply waits for TTS, so allow 60 s. */
const MAX_MISSED_FRAMES = 3000;

/**
 * Live PCM for one turn, with a jitter buffer. The player waits through short gaps (MAX_MISSED_FRAMES);
 * so this stream sends 20 ms of silence while it waits for the next audio. It ends only after end() and the queue is empty.
 */
export class LiveAudio extends Readable {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private ended = false;
  /** True while the stream holds audio back to build a buffer. The player waits meanwhile (see MAX_MISSED_FRAMES). */
  private buffering = true;
  private target = START_BUFFER_BYTES;
  private pending = false;
  /** Underruns: times playback ran dry and then played again. The gap is in ms. */
  underruns = 0;
  underrunMsTotal = 0;
  underrunMsMax = 0;
  /** Time (ms since epoch) when playback ran dry. Undefined while audio plays. */
  private dryAt: number | undefined;
  /** True once audio was given to the player. Waiting for the first audio is not an underrun. */
  private played = false;
  get writableEnded(): boolean { return this.ended; }
  write(pcm: Buffer): void {
    if (this.ended || this.destroyed) return;
    this.chunks.push(pcm); this.bytes += pcm.length;
    this.wake();
  }
  /** A source finished (for example one sentence): play what is buffered, do not wait for more. */
  release(): void { this.buffering = false; this.wake(); }
  end(): void { this.ended = true; this.buffering = false; this.wake(); }
  override _read(): void {
    // TTS sends audio in bursts that start small. Hold audio back until enough is buffered, so playback does not run dry.
    if (this.buffering && this.bytes >= this.target) this.buffering = false;
    if (!this.buffering) {
      const chunk = this.chunks.shift();
      if (chunk) { this.bytes -= chunk.length; this.pending = false; this.played = true; this.push(chunk); return; }
      if (this.ended) { this.pending = false; this.push(null); return; }
      // Ran dry: build a smaller buffer again before audio continues.
      this.buffering = true; this.target = REBUFFER_BYTES;
    }
    // No audio to give yet. Do not push silence: it would queue in front of audio that arrives later.
    this.pending = true;
  }
  private wake(): void { if (this.pending) this._read(); }
  /** The audio written so far ran out at `at` (ms since epoch), and the turn still has sentences to come. Starts an underrun. Ignored before the first audio plays. */
  startDry(at: number): void {
    if (this.played && this.dryAt === undefined) this.dryAt = at;
  }
  /** New audio was written at `at`. An open underrun ends here, and its gap is counted. */
  endDry(at: number): void {
    if (this.dryAt === undefined) return;
    const gap = Math.max(0, at - this.dryAt);
    this.dryAt = undefined;
    this.underruns++; this.underrunMsTotal += gap; this.underrunMsMax = Math.max(this.underrunMsMax, gap);
  }
  /** The speech ended with no sentence to come. An open underrun is dropped, not counted. */
  dropDry(): void { this.dryAt = undefined; }
}

/** The playback log of one turn. It is printed once, when the speech ends, if a sentence was spoken. */
interface PlaybackReport {
  underruns: number;
  underrun_ms_total: number;
  underrun_ms_max: number;
  sentences: number;
  tts_first_chunk_ms_max: number;
  tts_chunk_gap_ms_max: number;
  spoken_chars: number;
  event_loop_delay_ms_max: number;
  event_loop_delay_ms_p99: number;
}

/**
 * One reply's speech. One stream plays fillers and every sentence in order, so there is no gap between them.
 * Jobs run one at a time. Job N waits until job N-2 has finished playing, so at most one request is ahead of the one playing.
 */
class TurnSpeech {
  /** The one audio resource of the turn. It is played when the first audio is written. */
  private readonly out = new LiveAudio();
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private chain: Promise<void> = Promise.resolve();
  private readonly ends: number[] = [];
  private count = 0;
  /** Jobs queued and not yet finished. */
  pending = 0;
  private started = false;
  /** Time (ms since epoch) when the audio written so far has finished playing. */
  playEndsAt = 0;
  /** Sentences sent to TTS, in code points. The total is capped at VOICE_SPOKEN_MAX. */
  spokenChars = 0;
  capped = false;
  /** True once a sentence was queued for TTS. */
  streamed = false;
  /** Sentences that reached TTS. */
  sentences = 0;
  /** The slowest time from a job's start to its first chunk, in ms. */
  private firstChunkMs = 0;
  /** The largest gap between two chunks of one job, in ms. */
  private chunkGapMs = 0;
  /** Event loop delay while the turn's speech runs. It is enabled by the first job. Each turn has its own, so it starts at zero. */
  private readonly loop = monitorEventLoopDelay({ resolution: 10 });
  private reported = false;
  /** Fires when the audio written so far has played. Set again on each write. */
  private dryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly player: AudioPlayer, session: AbortSignal, private readonly onError: (error: unknown) => void, private readonly onReport: (report: PlaybackReport) => void) {
    this.signal = AbortSignal.any([session, this.controller.signal]);
  }

  /** Queues one job. The job calls write() with each PCM chunk it gets. A failed job reports once and stops the speech. */
  queue(job: (write: (pcm: Buffer) => void) => Promise<void>): void {
    const index = this.count++;
    this.pending++;
    this.loop.enable();
    this.chain = this.chain.then(async () => {
      try {
        if (index >= 2) await sleepUntil(this.ends[index - 2]!, this.signal);
        if (!this.signal.aborted) await this.timed(job);
        // The sentence is complete: play its tail now. The next sentence builds its own buffer when the stream runs dry.
        this.out.release();
      } catch (error) {
        if (!this.signal.aborted) this.onError(error);
        this.close();
      } finally {
        this.ends[index] = this.playEndsAt;
        this.pending--;
      }
    });
  }

  /** Resolves when every queued job has run. The chain never rejects. */
  settled(): Promise<void> { return this.chain; }

  /** Runs one job and records its chunk timing: the time to the first chunk, and the largest gap between two chunks. */
  private async timed(job: (write: (pcm: Buffer) => void) => Promise<void>): Promise<void> {
    const start = Date.now();
    let last = 0;
    await job(pcm => {
      if (pcm.length > 0) {
        const now = Date.now();
        if (last === 0) this.firstChunkMs = Math.max(this.firstChunkMs, now - start);
        else this.chunkGapMs = Math.max(this.chunkGapMs, now - last);
        last = now;
      }
      this.write(pcm);
    });
  }

  /** Ends the stream. Audio already written still plays. The playback log is printed when the speech ends. */
  end(): void {
    clearTimeout(this.dryTimer);
    this.out.dropDry();
    if (!this.out.writableEnded) this.out.end();
    this.report();
  }

  /** Starts a timer for when the audio written so far has played. If jobs are still pending then, playback has run dry. */
  private armDry(): void {
    clearTimeout(this.dryTimer);
    this.dryTimer = setTimeout(() => { if (this.pending > 0) this.out.startDry(this.playEndsAt); }, Math.max(0, this.playEndsAt - Date.now()));
    this.dryTimer.unref();
  }

  /** Stops the turn: abort jobs in flight, drop queued jobs, end the stream. */
  close(): void { this.controller.abort(); this.end(); }

  /** Prints the playback log once, after every job has settled. Nothing is printed when no sentence was spoken. */
  private report(): void {
    if (this.reported) return;
    this.reported = true;
    void this.settled().then(() => {
      this.loop.disable();
      if (this.sentences === 0) return;
      this.onReport({
        underruns: this.out.underruns,
        underrun_ms_total: this.out.underrunMsTotal,
        underrun_ms_max: this.out.underrunMsMax,
        sentences: this.sentences,
        tts_first_chunk_ms_max: this.firstChunkMs,
        tts_chunk_gap_ms_max: this.chunkGapMs,
        spoken_chars: this.spokenChars,
        event_loop_delay_ms_max: Math.round(this.loop.max / 1e6),
        event_loop_delay_ms_p99: Math.round(this.loop.percentile(99) / 1e6),
      });
    });
  }

  private write(pcm: Buffer): void {
    if (this.signal.aborted || this.out.writableEnded || pcm.length === 0) return;
    if (!this.started) {
      this.started = true;
      this.player.play(createAudioResource(this.out, { inputType: StreamType.Raw }));
    }
    // New audio ends any open underrun. Then the play-end time moves and the dry timer is set again.
    this.out.endDry(Date.now());
    this.playEndsAt = Math.max(this.playEndsAt, Date.now()) + pcm.length / PCM_BYTES_PER_MS;
    this.armDry();
    this.out.write(pcm);
  }
}

/** WP3: the text channel a voice join was asked in: the channel itself, or the parent of a thread. Undefined for other channels. */
export async function joinOrigin(client: Client, channelId: string): Promise<string | undefined> {
  // Only task threads use the origin. A failed lookup must not stop the join, so it gives undefined.
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.type === ChannelType.GuildText) return channel.id;
    if (channel?.isThread() && channel.parentId) {
      const parent = await client.channels.fetch(channel.parentId);
      if (parent?.type === ChannelType.GuildText) return parent.id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export class DiscordVoice {
  private session: Session | undefined;
  private readonly onVoiceState: (old: import('discord.js').VoiceState, next: import('discord.js').VoiceState) => void;
  private readonly proposals = new Map<string, Proposal>();
  private readonly runs = new Map<string, RunState>();
  private readonly unlisten: () => void;

  /** `instructions` returns the voice description for this server. `saveInstructions` stores a new one; "" clears it. */
  constructor(private readonly client: Client, private readonly server: string, private readonly config: Config, private readonly poster: VoicePoster, private readonly usage: UsageMeter, private readonly muted: (user: string) => boolean, private readonly instructions: () => string, private readonly saveInstructions: (value: string) => void | Promise<void>, private readonly connect: typeof joinVoiceChannel = joinVoiceChannel, private readonly createPlayer: () => AudioPlayer = () => createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop, maxMissedFrames: MAX_MISSED_FRAMES } })) {
    this.onVoiceState = (_old, next) => {
      if (next.guild.id !== server || !this.session) return;
      if (next.id === client.user?.id && next.channelId !== this.session.channel) { this.leave(); return; }
      const channel = next.guild.channels.cache.get(this.session.channel);
      if (channel?.type === ChannelType.GuildVoice && !channel.members.some(member => !member.user.bot)) this.leave();
    };
    client.on(Events.VoiceStateUpdate, this.onVoiceState);
    this.unlisten = liveText.subscribe(event => this.onLiveText(event));
  }

  register(registry: ToolRegistry): void {
    registry.register({ name: 'voice_skip', description: 'Call this when a voice transcript is only noise, a filler word or cut-off speech with no request. Slopbot then says and posts nothing for this turn. Do not write a reply after calling it.', scope: 'discord',
      fields: {},
      access: 'member', effect: 'read', execution: 'inline', retrySafe: true,
      execute: async ({ message }) => {
        const session = this.session, turn = session?.turn;
        if (!session || !turn || message.source !== 'voice' || message.channel !== session.channel) return 'Nothing to skip.';
        this.skipTurn(turn);
        return 'Skipped. Write no reply.';
      },
    });

    registry.register({ name: 'voice_say', description: 'Say these words aloud in the voice channel. Plain words only (no markdown, code, emoji or URLs; say numbers as words). For every voice request, call it with the spoken answer: short sentences, up to about 150 words (about one minute); shorter when a short answer is enough. Before a slow tool (search, fetch, code), you may first call it with one short line that tells what you will do. Then write the full answer for the chat with code, links and details as needed; the chat answer is not read aloud.', scope: 'discord',
      fields: {
        text: { type: 'string', description: 'The words to say aloud. Short spoken sentences in plain words, up to about 150 words.', required: true, max: VOICE_SPOKEN_MAX },
      },
      access: 'member', effect: 'read', execution: 'inline', retrySafe: true,
      execute: async ({ message }, args) => {
        const session = this.session, turn = session?.turn;
        if (!session || !turn || message.source !== 'voice' || message.channel !== session.channel) return 'Not in a voice turn.';
        if (session.replies === 'text') return 'Text-only session; not spoken.';
        if (turn.skipped) return 'Skipped. Nothing is spoken.';
        // All voice_say calls of a turn share VOICE_SPOKEN_MAX. Text over the room left is cut, and later calls speak nothing.
        const room = VOICE_SPOKEN_MAX - turn.speech.spokenChars;
        if (turn.speech.capped || room <= 0) return 'Spoken limit reached. Nothing more is spoken in this turn.';
        turn.said = true;
        const splitter = new SentenceSplitter();
        const full = plainSpoken(String(args.text ?? ''));
        const plain = cutSpoken(full, room);
        this.queueSentences(session, turn, [...splitter.push(plain), ...splitter.flush()]);
        if (plain !== full.trim()) turn.speech.capped = true;
        turn.toolAfterSay = false;
        return 'Speaking.';
      },
    });

    registry.register({ name: 'voice', description: "Join your voice channel to talk, leave it, or show voice status and the voice style. Use propose when a user asks to change how Slopbot's voice sounds: draft a concrete description (gender, age, pitch, pace, tone) and never name a real person; a server admin then applies it. style sets the voice directly and is for server admins only.", scope: 'discord',
      fields: {
        action: { type: 'string', description: 'Voice action. style sets the voice (server admins). propose posts a voice for an admin to apply.', choices: ['join', 'leave', 'status', 'style', 'propose'], required: true },
        instructions: { type: 'string', description: `Voice description for style or propose, for example "A calm adult woman with a warm, medium pitch, a steady pace and a friendly tone." Up to ${VOICE_INSTRUCTIONS_MAX} characters. For style, "default" restores the default voice.`, max: VOICE_INSTRUCTIONS_MAX },
        reply: { type: 'string', description: 'For join. voice (default) reads Slopbot\'s replies aloud. text only posts transcripts and replies in chat: no audio and no Thunder calls.', choices: ['voice', 'text'] },
      },
      access: 'member', effect: 'write', execution: 'inline', retrySafe: true,
      resource: () => `voice:${this.server}`, writes: args => args.action !== 'status',
      execute: async ({ message, isAdmin }, args) => {
        if (args.action === 'status') return this.status();
        if (args.action === 'style') return this.style(message, isAdmin, String(args.instructions ?? ''));
        if (args.action === 'propose') return this.propose(message, String(args.instructions ?? ''));
        const guild = await this.client.guilds.fetch(this.server);
        const member = await guild.members.fetch({ user: message.author, force: true });
        if (args.action === 'leave') {
          if (this.session && !isAdmin && member.voice.channelId !== this.session.channel) throw new ToolError('Join the active voice channel or ask a server admin to stop the session.');
          // WP1: a leave from a voice turn lets the reply finish first. endTurn() leaves after it.
          const session = this.session, turn = session?.turn;
          if (message.source === 'voice' && session && turn && message.channel === session.channel) {
            turn.leaveAfter = true;
            return 'Leaving after this reply.';
          }
          this.leave(); return 'Left the voice channel.';
        }
        if (this.config.mock) throw new ToolError('Voice requires LLM_MODE=provider and an AI key with squall and thunder access.');
        if (this.muted(message.author)) throw new ToolError('You are muted in Slopbot.');
        if (!(await this.usage.limiter.check(message.author)).allowed) throw new ToolError('Your Slopbot usage limit has been reached.');
        const channel = member.voice.channel;
        if (!channel || channel.type !== ChannelType.GuildVoice) throw new ToolError('Join a server voice channel first.');
        const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
        const bot = await guild.members.fetchMe();
        if (!channel.permissionsFor(member)?.has(permissions) || !channel.permissionsFor(bot)?.has(permissions)) throw new ToolError('You and Slopbot need View Channel, Connect and Speak permissions in that voice channel.');
        if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.SendMessages)) throw new ToolError('Slopbot needs Send Messages in the voice channel to announce that it is listening.');
        if (this.session) {
          if (this.session.channel === channel.id) return `Already listening in <#${channel.id}>.`;
          throw new ToolError('Leave the existing voice session before joining another channel.');
        }
        const replies = args.reply === 'text' ? 'text' : 'voice';
        await channel.send({ content: replies === 'text'
          ? "Slopbot is joining to listen. Human speech is sent to PMServers for transcription. Each transcript is posted in this channel's chat. Replies are text only: Slopbot does not speak in this session. I handle one speaker at a time. Use /voice action:leave to stop."
          : "Slopbot is joining to listen and reply aloud. Human speech is sent to PMServers for transcription. Each transcript is posted in this channel's chat, and replies use Slopbot's normal model and tools. I handle one speaker at a time. Use /voice action:leave to stop.", allowedMentions: { parse: [] } });
        const origin = await joinOrigin(this.client, message.channel);
        await this.join(channel.id, replies, origin);
        return replies === 'text'
          ? `Joined <#${channel.id}>. I listen to human speakers and post each transcript in this channel's chat. Replies are text only in this session: I do not speak. I handle one speaker at a time. Use /voice action:leave to stop. I leave after five minutes of inactivity.`
          : `Joined <#${channel.id}>. I listen to human speakers, post each transcript in this channel's chat, and reply aloud with Slopbot's normal model and tools, one speaker at a time. Speech is sent to PMServers for processing. Use /voice action:leave to stop. I leave after five minutes of inactivity.`;
      },
    });
  }

  private status(): string {
    if (!this.session) return `No active voice session.\nVoice style: ${this.instructions() || `preset ${this.config.voice?.voice}`}`;
    const { channel, replies, turn } = this.session;
    const state = turn ? `Busy (replying to ${this.speakerName(turn.user)})` : 'Listening';
    return `Voice session in <#${channel}>.\nReplies: ${replies}\nState: ${state}\nVoice style: ${this.instructions() || `preset ${this.config.voice?.voice}`}`;
  }

  /** The display name of a speaker in this server, or the user ID when it is not cached. */
  private speakerName(user: string): string {
    return this.client.guilds.cache.get(this.server)?.members.cache.get(user)?.displayName ?? user;
  }

  /** The voice style set by an admin. "default" or empty clears it. Plays or posts a preview. */
  private async style(message: Message, isAdmin: boolean, raw: string): Promise<string> {
    if (!isAdmin) throw new ToolError('Only server admins can change the voice.');
    await this.saveInstructions(styleText(raw));
    const wav = await this.previewWav(message.author, this.instructions());
    if (wav) await this.playOrPost(message.channel, wav, 'Voice preview.');
    return 'Voice updated.';
  }

  /** The model drafts a voice style. An admin applies it with the Apply button. */
  private async propose(message: Message, raw: string): Promise<string> {
    const instructions = styleText(raw);
    if (!instructions) throw new ToolError(`Describe the voice in 1 to ${VOICE_INSTRUCTIONS_MAX} characters.`);
    if (this.muted(message.author)) throw new ToolError('You are muted in Slopbot.');
    if (!(await this.usage.limiter.check(message.author)).allowed) throw new ToolError('Your Slopbot usage limit has been reached.');
    const channel = await this.client.channels.fetch(message.channel).catch(() => undefined);
    if (!channel?.isTextBased() || !channel.isSendable()) throw new ToolError('Slopbot cannot post in this channel.');
    const wav = await this.previewWav(message.author, instructions);
    const id = randomUUID();
    for (const [key, proposal] of this.proposals) if (Date.now() > proposal.expiresAt) this.proposals.delete(key);
    this.proposals.set(id, { instructions, proposer: message.author, expiresAt: Date.now() + PROPOSAL_MS });
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`slopvoice:${id}:apply`).setLabel('Apply').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`slopvoice:${id}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    await channel.send({ content: `Proposed voice: ${instructions}`, ...(wav ? { files: [previewFile(wav)] } : {}), components: [buttons], allowedMentions: { parse: [] } });
    return 'Proposed voice posted. A server admin can click Apply within 15 minutes.';
  }

  /** The Apply and Cancel buttons of a voice proposal. Only a server admin can apply one. */
  async button(interaction: ButtonInteraction): Promise<void> {
    if (interaction.guildId !== this.server) return;
    const [, id = '', action] = interaction.customId.split(':');
    const proposal = this.proposals.get(id);
    if (!proposal) { await interaction.reply({ content: 'This voice proposal is no longer open.', flags: MessageFlags.Ephemeral }); return; }
    if (Date.now() > proposal.expiresAt) { this.proposals.delete(id); await interaction.update({ content: 'Voice proposal expired.', components: [] }); return; }
    const admin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
    if (action === 'cancel') {
      if (!admin && interaction.user.id !== proposal.proposer) { await interaction.reply({ content: 'Only server admins or the proposer can cancel this voice proposal.', flags: MessageFlags.Ephemeral }); return; }
      this.proposals.delete(id);
      await interaction.update({ content: 'Proposal cancelled.', components: [] });
      return;
    }
    if (!admin) { await interaction.reply({ content: 'Only server admins can apply a voice.', flags: MessageFlags.Ephemeral }); return; }
    this.proposals.delete(id);
    try { await this.saveInstructions(proposal.instructions); }
    catch (error) {
      logError('discord_voice_apply_failed', error, { server: this.server });
      await interaction.reply({ content: 'Could not save the voice. Propose it again.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update({ content: `Voice updated by <@${interaction.user.id}>.`, components: [], allowedMentions: { parse: [] } });
  }

  /** Thunder preview of a voice style, as WAV. Returns undefined when it fails; the failure is logged. */
  private async previewWav(user: string, instructions: string): Promise<Buffer | undefined> {
    // A text session plays no audio, so it makes no preview.
    if (this.session?.replies === 'text') return undefined;
    try {
      const wav = await this.audio().speakWav(PREVIEW_TEXT, new AbortController().signal, instructions);
      // Thunder is billed at $10/1M characters.
      await this.usage.limiter.record(user, Array.from(PREVIEW_TEXT).length * 10);
      return wav;
    } catch (error) { logError('discord_voice_preview_failed', error, { server: this.server }); return undefined; }
  }

  /** Plays the preview in a live voice session, else posts it as a WAV in the channel. Failures are logged. */
  private async playOrPost(channel: string, wav: Buffer, content: string): Promise<void> {
    const session = this.session;
    try {
      if (session) { this.playClip(session, speechPcm(wav)); return; }
      const target = await this.client.channels.fetch(channel);
      if (!target?.isTextBased() || !target.isSendable()) throw new Error('Preview channel unavailable');
      await target.send({ content, files: [previewFile(wav)], allowedMentions: { parse: [] } });
    } catch (error) { logError('discord_voice_preview_failed', error, { server: this.server, channel }); }
  }

  private audio(): PmAudio {
    return new PmAudio(this.config.baseUrl, this.config.apiKey, this.config.voice?.voice ?? 'alloy');
  }

  private async join(channel: string, replies: 'voice' | 'text', origin: string | undefined): Promise<void> {
    const guild = await this.client.guilds.fetch(this.server);
    const connection = this.connect({ guildId: guild.id, channelId: channel, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    const player = this.createPlayer();
    const abort = new AbortController(), captures = new Set<AudioReceiveStream>();
    const audio = new PmAudio(this.config.baseUrl, this.config.apiKey, this.config.voice?.voice ?? 'alloy');
    let idle: ReturnType<typeof setTimeout>, lastError = 0;
    const refresh = () => { clearTimeout(idle); idle = setTimeout(() => this.leave(), IDLE_MS); idle.unref(); };
    const fail = (error: unknown) => {
      if (abort.signal.aborted) return;
      logError('discord_voice_failed', error, { server: this.server, channel });
      const target = guild.channels.cache.get(channel);
      if (Date.now() - lastError > 30_000 && target?.isSendable()) {
        lastError = Date.now();
        void target.send({ content: `Voice conversation failed. ${errorReply(error)}`, allowedMentions: { parse: [] } }).catch(error => logError('discord_voice_notice_failed', error, { server: this.server, channel }));
      }
    };
    const session: Session = { channel, connection, abort, player, audio, replies, busy: false, turn: undefined, fillers: undefined, origin, listening: undefined, listeningAt: Number.NEGATIVE_INFINITY, refresh, fail, stop: () => {
      // Leaving: no listening line for the turn that ends here. The line is removed.
      abort.abort(); clearTimeout(idle); if (session.turn) this.endTurn(session, session.turn); player.stop(true);
      void this.removeListening(session).catch(error => logError('discord_voice_listening_failed', error, { server: this.server, channel }));
      for (const capture of captures) capture.destroy();
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    } };
    this.session = session;
    this.onSession?.(channel, undefined);
    refresh();
    connection.subscribe(player);
    connection.on('error', error => { fail(error); if (this.session === session) this.leave(); });
    player.on('error', fail);
    connection.on(VoiceConnectionStatus.Destroyed, () => { if (this.session === session) this.leave(); });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Allow the library to reconnect, but release a kicked or broken connection promptly.
      void entersState(connection, VoiceConnectionStatus.Ready, 5000).catch(() => { if (this.session === session) this.leave(); });
    });
    connection.receiver.speaking.on('start', user => {
      if (session.busy || abort.signal.aborted || this.muted(user)) return;
      const turn = this.startTurn(session, user);
      let posted = false, failed = false;
      void (async () => {
        // Subscribe at the speaking event; a REST fetch here can lose the first words.
        const member = guild.members.cache.get(user);
        if (!member || member.user.bot || member.voice.channelId !== channel || abort.signal.aborted) return;
        refresh();
        const pcm = await this.capture(connection, user, captures, abort.signal);
        if (pcm.length < 19200 || member.voice.channelId !== channel || this.muted(user)) return;
        if (!(await this.usage.limiter.check(user)).allowed) return;
        const transcript = await audio.transcribe(pcm, abort.signal);
        // Squall is billed at $0.004/minute, independent of token prices.
        await this.usage.limiter.record(user, Math.ceil(pcm.length / 192000 / 60 * 4000));
        if (!transcript || await this.usage.overGrace({ server: this.server, user })) return;
        if (session.turn !== turn || abort.signal.aborted) return;
        const sent = await this.poster.reply({ user, server: this.server, channel, text: transcript.slice(0, 2000), kind: 'voice' });
        posted = true;
        turn.transcript = { channel, messageId: sent.messageId };
        this.startFillers(session, turn);
        void this.signTranscript(turn, EAR);
      })().catch(error => { failed = true; fail(error); }).finally(() => { if (!posted) this.endTurn(session, turn, !failed && !abort.signal.aborted); });
    });
    try { await entersState(connection, VoiceConnectionStatus.Ready, 20_000); }
    catch (error) { if (this.session === session) this.leave(); throw error; }
    this.listen(session);
  }

  /** Reads the bot's reply aloud. Sentences already spoken as the model streamed them are not spoken again. */
  async speak(channel: string, text: string): Promise<void> {
    const session = this.session, turn = session?.turn;
    if (!session || session.channel !== channel || !turn) return;
    // A skipped turn (voice_skip, or a [SKIP] marker in the reply) speaks nothing and ends silently.
    const skipped = turn.skipped || containsSkipMarker(text);
    if (skipped) { this.skipTurn(turn); void this.signTranscript(turn, SLEEP, EAR); }
    if (session.replies === 'text') { this.endTurn(session, turn, true); if (this.session === session) session.refresh(); return; }
    try {
      const speech = turn.speech;
      const { spoken, chat } = splitSpeak(text);
      // A <speak> block is the spoken answer. It is not read again when voice_say already spoke and no tool ran after it.
      // After a tool that came after voice_say, the chat answer is spoken too.
      if (!skipped && spoken !== undefined && (!turn.said || turn.toolAfterSay)) this.queueFinal(session, turn, plainSpoken(spoken));
      else if (!skipped && turn.toolAfterSay) this.queueFinal(session, turn, spokenText(chat));
      // Nothing was streamed (an error reply, or no sentence): speak the whole reply once.
      else if (!speech.streamed && !skipped && !turn.said) {
        const said = spokenText(chat);
        if (said) this.queueSpeech(session, turn, said);
      }
      await speech.settled();
      speech.end();
      await sleepUntil(speech.playEndsAt, session.abort.signal);
      // Silence padding is not in the estimate. Wait until the player has really finished.
      if (session.player.state && session.player.state.status !== AudioPlayerStatus.Idle) await entersState(session.player, AudioPlayerStatus.Idle, AbortSignal.any([session.abort.signal, AbortSignal.timeout(60_000)])).catch(() => undefined);
      if (session.turn !== turn) return;
      this.endTurn(session, turn, true);
      // The session may have left in endTurn (leave after the reply). Its idle timer must not start then.
      if (this.session === session) session.refresh();
    } catch (error) { session.fail(error); this.endTurn(session, turn); }
  }

  /**
   * Speaks a filler when the turn has been silent for VOICE_FILLER_GAP_MS while the bot works.
   * At most VOICE_FILLER_MAX per turn. Each clip is made once per session. Text sessions play nothing.
   */
  checkFiller(channel: string, now = Date.now()): void {
    const session = this.session, turn = session?.turn;
    if (!session || !turn || session.channel !== channel || turn.filler === undefined) return;
    const speech = turn.speech;
    if (session.turn !== turn || turn.skipped || speech.capped || session.replies === 'text') return;
    if (speech.pending > 0 || now < Math.max(speech.playEndsAt, turn.quietFrom) + VOICE_FILLER_GAP_MS) return;
    if (turn.fillers >= VOICE_FILLER_MAX) { clearInterval(turn.filler); return; }
    const text = VOICE_FILLER_TEXTS[turn.fillers % VOICE_FILLER_TEXTS.length]!;
    turn.fillers++;
    const instructions = this.instructions();
    if (session.fillers?.instructions !== instructions) session.fillers = { instructions, clips: new Map() };
    const clips = session.fillers.clips;
    let clip = clips.get(text);
    if (!clip) {
      clip = session.audio.speak(text, session.abort.signal, instructions).then(async pcm => {
        // Thunder is billed at $10/1M characters.
        await this.usage.limiter.record(turn.user, Array.from(text).length * 10);
        return pcm;
      });
      clips.set(text, clip);
      clip.catch(() => { if (clips.get(text) === clip) clips.delete(text); });
    }
    const made = clip;
    // A failed filler is reported, and the reply still plays.
    speech.queue(async write => {
      const pcm = await made.catch(error => { session.fail(error); });
      if (pcm && !turn.skipped) write(pcm);
    });
  }

  /** Live reply text. Sentences of a reply in a voice turn are queued for speech as the model streams them. */
  private onLiveText(event: LiveTextEvent): void {
    const run = this.runs.get(event.runId) ?? this.openRun(event);
    if (!run) return;
    const session = this.session;
    if (event.kind === 'text') { if (session) this.runText(session, run, event.text); return; }
    if (event.kind === 'end') { this.runs.delete(event.runId); if (session) this.endRun(session, run); }
  }

  /** A run of a pending voice turn in this channel. Other runs are not read. */
  private openRun(event: LiveTextEvent): RunState | undefined {
    const session = this.session, turn = session?.turn;
    if (!session || !turn || session.replies !== 'voice' || session.abort.signal.aborted) return undefined;
    if (event.message.source !== 'voice' || event.message.channel !== session.channel) return undefined;
    const run: RunState = { turn, splitter: new SentenceSplitter(), head: '', held: '', raw: '', mode: 'undecided' };
    this.runs.set(event.runId, run);
    return run;
  }

  private runText(session: Session, run: RunState, text: string): void {
    if (run.mode === 'skip' || run.turn.skipped || run.turn.said) return;
    run.raw += text;
    // A [SKIP] marker anywhere in the reply skips the turn. Text sent before the marker arrived cannot be recalled.
    if (containsSkipMarker(run.raw)) { run.mode = 'skip'; this.skipTurn(run.turn); return; }
    // A <speak> block is spoken by speak() from the final reply. This run stops streaming; the turn is not skipped.
    if (/<speak/i.test(run.raw)) { run.mode = 'skip'; return; }
    if (run.mode === 'undecided') {
      run.head += text;
      if (!this.decide(run, false)) return;
      text = run.head; run.head = '';
    }
    if (run.mode !== 'stream') return;
    // Hold back the end that might still become "[SKIP]", until a later delta shows it is not.
    const all = run.held + text;
    const hold = heldSkipLength(all);
    run.held = all.slice(all.length - hold);
    this.queueSentences(session, run.turn, run.splitter.push(all.slice(0, all.length - hold)));
  }

  private endRun(session: Session, run: RunState): void {
    if (run.mode === 'undecided') this.decide(run, true);
    if (run.mode === 'stream') this.queueSentences(session, run.turn, [...run.splitter.push(run.held + run.head), ...run.splitter.flush()]);
    run.head = ''; run.held = '';
  }

  /** Decides from the start of a reply whether it is read aloud. An error code is not read; the fallback speaks the error text. */
  private decide(run: RunState, final: boolean): boolean {
    const head = run.head.trimStart();
    const lower = head.toLowerCase();
    // A <speak> block is not streamed. speak() reads it from the final reply.
    if (lower.startsWith('<speak')) { run.mode = 'skip'; return true; }
    // A "[" might start an error code or a skip marker. Wait for the closing "]" or for enough text.
    // A "<" might start a <speak> block. Wait until it is clear.
    if (!final && (!head || '<speak'.startsWith(lower) || (/^\\?\[/.test(head) && !head.includes(']') && head.length < 40))) return false;
    run.mode = isErrorReply(run.head) ? 'skip' : 'stream';
    return true;
  }

  /** Queues plain final text, such as a <speak> block or the chat answer after a tool. It is cut to the room left in the turn. */
  private queueFinal(session: Session, turn: Turn, plain: string): void {
    const room = VOICE_SPOKEN_MAX - turn.speech.spokenChars;
    const cut = cutSpoken(plain, room);
    if (cut !== plain.trim()) turn.speech.capped = true;
    const splitter = new SentenceSplitter();
    this.queueSentences(session, turn, [...splitter.push(cut), ...splitter.flush()]);
  }

  private queueSentences(session: Session, turn: Turn, sentences: string[]): void {
    for (const sentence of sentences) {
      const speech = turn.speech;
      if (speech.capped || turn.skipped) return;
      let said = plainSpoken(sentence);
      const room = VOICE_SPOKEN_MAX - speech.spokenChars;
      if (Array.from(said).length >= room) { said = cutSpoken(said, room); speech.capped = true; }
      if (!said) continue;
      speech.spokenChars += Array.from(said).length;
      speech.streamed = true;
      this.queueSpeech(session, turn, said);
    }
  }

  /** One TTS request for `text`, streamed into the turn's speech. Thunder is billed per character, to the turn user. */
  private queueSpeech(session: Session, turn: Turn, text: string): void {
    const speech = turn.speech;
    if (turn.skipped) return;
    speech.queue(async write => {
      if (await this.usage.overGrace({ server: this.server, user: turn.user })) { speech.capped = true; return; }
      speech.sentences++;
      for await (const pcm of session.audio.speakStream(text, speech.signal, this.instructions())) write(pcm);
      // Thunder is billed at $10/1M characters.
      await this.usage.limiter.record(turn.user, Array.from(text).length * 10);
    });
  }

  /** Plays a clip now, instead of the audio that plays. Used for a voice preview in a live session. */
  private playClip(session: Session, pcm: Buffer): void {
    session.player.play(createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw }));
  }

  private startTurn(session: Session, user: string): Turn {
    const turn: Turn = { user, channel: session.channel, fillers: 0, quietFrom: Date.now(), leaveAfter: false, toolAfterSay: false, skipped: false, said: false, speech: new TurnSpeech(session.player, session.abort.signal, error => session.fail(error), report => console.log(JSON.stringify({ type: 'voice_playback', server: this.server, channel: session.channel, ...report }))), timer: setTimeout(() => this.endTurn(session, turn, true), VOICE_TURN_TIMEOUT_MS) };
    turn.timer.unref();
    session.busy = true; session.turn = turn;
    return turn;
  }

  /** Starts the filler checks. The silence counts from now: the transcript is posted and the bot starts work. */
  private startFillers(session: Session, turn: Turn): void {
    if (session.replies === 'text' || session.turn !== turn) return;
    turn.quietFrom = Date.now();
    turn.filler = setInterval(() => this.checkFiller(session.channel), 1000);
    turn.filler.unref();
  }

  /**
   * Ends a turn. `normal` is true when the reply was spoken, posted, skipped, empty, or timed out.
   * A leave or an abort ends it without the listening line.
   */
  private endTurn(session: Session, turn: Turn, normal = false): void {
    if (session.turn !== turn) return;
    clearTimeout(turn.timer); clearInterval(turn.filler); session.turn = undefined; session.busy = false;
    skippedChannels.delete(turn.channel);
    turn.speech.close();
    for (const [id, run] of this.runs) if (run.turn === turn) this.runs.delete(id);
    if (normal) this.listen(session);
    // WP1: the voice tool's leave ran in this turn. Leave now that the reply has ended.
    if (turn.leaveAfter && this.session === session) this.leave();
  }

  /** Marks the turn skipped: its queued and in-flight speech stops. Audio already written still plays. */
  private skipTurn(turn: Turn): void {
    if (turn.skipped) return;
    turn.skipped = true;
    skippedChannels.add(turn.channel);
    turn.speech.close();
  }

  /** The text channel of the session, or undefined when the bot cannot post there. */
  private async textChannel(id: string) {
    const channel = await this.client.channels.fetch(id).catch(() => undefined);
    return channel?.isTextBased() && channel.isSendable() ? channel : undefined;
  }

  /** Posts the "Listening" line. The previous line of this session is deleted first. At most one post per window. */
  private listen(session: Session): void {
    const now = Date.now();
    if (now - session.listeningAt < LISTENING_GAP_MS) return;
    session.listeningAt = now;
    const previous = session.listening;
    session.listening = undefined;
    void this.postListening(session, previous).catch(error => logError('discord_voice_listening_failed', error, { server: this.server, channel: session.channel }));
  }

  private async postListening(session: Session, previous: string | undefined): Promise<void> {
    const channel = await this.textChannel(session.channel);
    if (!channel) return;
    if (previous) await channel.messages.fetch(previous).then(message => message.delete()).catch(error => logError('discord_voice_listening_failed', error, { server: this.server, channel: session.channel }));
    const sent = await channel.send({ content: LISTENING_LINE, allowedMentions: { parse: [] } });
    // The session left while the line was posted: it does not stay up.
    if (session.abort.signal.aborted) await sent.delete().catch(error => logError('discord_voice_listening_failed', error, { server: this.server, channel: session.channel }));
    else session.listening = sent.id;
  }

  /** Deletes the session's "Listening" line, if one is up. Used on leave. */
  private async removeListening(session: Session): Promise<void> {
    const id = session.listening;
    session.listening = undefined;
    if (!id) return;
    const channel = await this.textChannel(session.channel);
    if (channel) await channel.messages.fetch(id).then(message => message.delete());
  }

  /** Adds `add` to the turn's transcript message and removes `remove` from it. Reaction errors are logged, not thrown. */
  private async signTranscript(turn: Turn, add: string, remove?: string): Promise<void> {
    const at = turn.transcript;
    if (!at) return;
    try {
      const channel = await this.client.channels.fetch(at.channel);
      if (!channel?.isTextBased() || !('messages' in channel)) throw new Error('Transcript channel unavailable');
      const message = await channel.messages.fetch(at.messageId);
      const reaction = remove ? message.reactions.cache.get(remove) : undefined;
      if (reaction && this.client.user) await reaction.users.remove(this.client.user.id);
      await message.react(add);
    } catch (error) { logError('discord_voice_sign_failed', error, { server: this.server, channel: at.channel, messageId: at.messageId }); }
  }


  private capture(connection: VoiceConnection, user: string, captures: Set<AudioReceiveStream>, signal: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const stream = connection.receiver.subscribe(user, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
      captures.add(stream);
      const decoder = new OpusScript(48000, 2, OpusScript.Application.VOIP);
      const chunks: Buffer[] = []; let bytes = 0, finished = false;
      const finish = (error?: unknown) => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal.removeEventListener('abort', cancel); captures.delete(stream); stream.destroy(); decoder.delete();
        if (error) reject(error); else resolve(Buffer.concat(chunks));
      };
      const cancel = () => finish(signal.reason);
      const timer = setTimeout(() => finish(), 30_000);
      signal.addEventListener('abort', cancel, { once: true });
      stream.on('data', (packet: Buffer) => {
        try {
          const pcm = Buffer.from(decoder.decode(packet));
          if (bytes + pcm.length > MAX_AUDIO_BYTES) { finish(); return; }
          bytes += pcm.length; chunks.push(pcm);
        } catch (error) { finish(error); }
      });
      stream.once('end', () => finish()); stream.once('error', finish);
      stream.once('close', () => finish(signal.aborted ? signal.reason : undefined));
      if (signal.aborted) cancel();
    });
  }

  /** Called with the channel when a session starts, and with undefined when it ends. */
  onSession: ((channel: string | undefined, previous: string | undefined) => void) | undefined;
  /** A tool started in a voice turn. The tool progress hook in discord.ts calls it. After voice_say, the final answer is spoken too. */
  toolStarted(channel: string, tool: string): void {
    const turn = this.session?.channel === channel ? this.session.turn : undefined;
    if (turn?.said && tool !== 'voice_say' && tool !== 'voice_skip') turn.toolAfterSay = true;
  }

  /** WP3: the task parent for a request in `channel`: the session's origin when `channel` is the live voice channel, else undefined. */
  taskParent(channel: string): string | undefined {
    return this.session?.channel === channel ? this.session.origin : undefined;
  }

  leave(): void { const session = this.session; this.session = undefined; session?.stop(); if (session) this.onSession?.(undefined, session.channel); }
  stop(): void { this.leave(); this.client.off(Events.VoiceStateUpdate, this.onVoiceState); this.unlisten(); }
}
