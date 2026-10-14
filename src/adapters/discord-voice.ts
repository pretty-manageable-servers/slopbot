import { Readable } from 'node:stream';
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
import { cutSpoken, isErrorReply, plainSpoken, SentenceSplitter, spokenText, VOICE_CUE_TEXT, VOICE_INSTRUCTIONS_MAX, VOICE_SPOKEN_MAX, VOICE_TURN_TIMEOUT_MS } from '../voice-rules.js';
import { liveText, type LiveTextEvent } from '../live-text.js';
import { PmAudio, speechPcm } from './audio.js';

const MAX_AUDIO_BYTES = 30 * 192000;
const IDLE_MS = 5 * 60_000;
const PROPOSAL_MS = 15 * 60_000;
const PREVIEW_TEXT = 'Hi, this is my new voice.';

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
interface Turn { user: string; timer: ReturnType<typeof setTimeout>; cued: boolean; speech: TurnSpeech }

/** One reply run's text, read as it streams. `mode` decides once whether the reply is read aloud. */
interface RunState { turn: Turn; splitter: SentenceSplitter; head: string; mode: 'undecided' | 'stream' | 'skip' }

interface Session {
  channel: string;
  connection: VoiceConnection;
  abort: AbortController;
  player: AudioPlayer;
  audio: PmAudio;
  busy: boolean;
  /** 'voice' reads replies aloud. 'text' only captures speech and posts transcripts. */
  replies: 'voice' | 'text';
  turn: Turn | undefined;
  /** The cue clip for one set of voice instructions. Made again when the instructions change. Plays do not bill. */
  cue: { instructions: string; clip: Promise<Buffer> } | undefined;
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

/** 20 ms of silence in Discord raw format: 48 kHz, stereo, 16-bit. */
const SILENCE_FRAME = Buffer.alloc(3840);

/**
 * Live PCM for one turn. The Discord player stops a resource as soon as its stream has no data,
 * so this stream sends 20 ms of silence while it waits for the next audio. It ends only after end() and the queue is empty.
 */
export class LiveAudio extends Readable {
  private readonly chunks: Buffer[] = [];
  private ended = false;
  private waiting: ReturnType<typeof setTimeout> | undefined;
  get writableEnded(): boolean { return this.ended; }
  write(pcm: Buffer): void {
    if (this.ended || this.destroyed) return;
    this.chunks.push(pcm);
    this.wake();
  }
  end(): void { this.ended = true; this.wake(); }
  override _read(): void {
    const chunk = this.chunks.shift();
    if (chunk) { this.push(chunk); return; }
    if (this.ended) { this.push(null); return; }
    // Nothing yet: send one silence frame after 20 ms, unless audio arrives first.
    this.waiting ??= setTimeout(() => { this.waiting = undefined; if (!this.destroyed && !this.ended && !this.chunks.length) this.push(SILENCE_FRAME); else this._read(); }, 20);
  }
  private wake(): void {
    if (!this.waiting) return;
    clearTimeout(this.waiting); this.waiting = undefined;
    this._read();
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.waiting) clearTimeout(this.waiting);
    callback(error);
  }
}

/**
 * One reply's speech. One stream plays the cue and every sentence in order, so there is no gap between them.
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
  private started = false;
  /** Time (ms since epoch) when the audio written so far has finished playing. */
  playEndsAt = 0;
  /** Sentences sent to TTS, in code points. The total is capped at VOICE_SPOKEN_MAX. */
  spokenChars = 0;
  capped = false;
  /** True once a sentence was queued for TTS. */
  streamed = false;

  constructor(private readonly player: AudioPlayer, session: AbortSignal, private readonly onError: (error: unknown) => void) {
    this.signal = AbortSignal.any([session, this.controller.signal]);
  }

  /** Queues one job. The job calls write() with each PCM chunk it gets. A failed job reports once and stops the speech. */
  queue(job: (write: (pcm: Buffer) => void) => Promise<void>): void {
    const index = this.count++;
    this.chain = this.chain.then(async () => {
      try {
        if (index >= 2) await sleepUntil(this.ends[index - 2]!, this.signal);
        if (!this.signal.aborted) await job(pcm => this.write(pcm));
      } catch (error) {
        if (!this.signal.aborted) this.onError(error);
        this.close();
      } finally {
        this.ends[index] = this.playEndsAt;
      }
    });
  }

  /** Resolves when every queued job has run. The chain never rejects. */
  settled(): Promise<void> { return this.chain; }

  /** Ends the stream. Audio already written still plays. */
  end(): void { if (!this.out.writableEnded) this.out.end(); }

  /** Stops the turn: abort jobs in flight, drop queued jobs, end the stream. */
  close(): void { this.controller.abort(); this.end(); }

  private write(pcm: Buffer): void {
    if (this.signal.aborted || this.out.writableEnded || pcm.length === 0) return;
    if (!this.started) {
      this.started = true;
      this.player.play(createAudioResource(this.out, { inputType: StreamType.Raw }));
    }
    this.playEndsAt = Math.max(this.playEndsAt, Date.now()) + pcm.length / PCM_BYTES_PER_MS;
    this.out.write(pcm);
  }
}

export class DiscordVoice {
  private session: Session | undefined;
  private readonly onVoiceState: (old: import('discord.js').VoiceState, next: import('discord.js').VoiceState) => void;
  private readonly proposals = new Map<string, Proposal>();
  private readonly runs = new Map<string, RunState>();
  private readonly unlisten: () => void;

  /** `instructions` returns the voice description for this server. `saveInstructions` stores a new one; "" clears it. */
  constructor(private readonly client: Client, private readonly server: string, private readonly config: Config, private readonly poster: VoicePoster, private readonly usage: UsageMeter, private readonly muted: (user: string) => boolean, private readonly instructions: () => string, private readonly saveInstructions: (value: string) => void | Promise<void>, private readonly connect: typeof joinVoiceChannel = joinVoiceChannel, private readonly createPlayer: () => AudioPlayer = () => createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } })) {
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
          ? "Slopbot is joining to listen. Human speech is sent to PMServers for transcription. Each transcript is posted in this channel's chat. Replies are text only: Slopbot does not speak in this session. I handle one speaker at a time. Use /slopbot voice action:leave to stop."
          : "Slopbot is joining to listen and reply aloud. Human speech is sent to PMServers for transcription. Each transcript is posted in this channel's chat, and replies use Slopbot's normal model and tools. I handle one speaker at a time. Use /slopbot voice action:leave to stop.", allowedMentions: { parse: [] } });
        await this.join(channel.id, replies);
        return replies === 'text'
          ? `Joined <#${channel.id}>. I listen to human speakers and post each transcript in this channel's chat. Replies are text only in this session: I do not speak. I handle one speaker at a time. Use /slopbot voice action:leave to stop. I leave after five minutes of inactivity.`
          : `Joined <#${channel.id}>. I listen to human speakers, post each transcript in this channel's chat, and reply aloud with Slopbot's normal model and tools, one speaker at a time. Speech is sent to PMServers for processing. Use /slopbot voice action:leave to stop. I leave after five minutes of inactivity.`;
      },
    });
  }

  private status(): string {
    const session = this.session ? `Voice session in <#${this.session.channel}>.\nReplies: ${this.session.replies}` : 'No active voice session.';
    return `${session}\nVoice style: ${this.instructions()}`;
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

  private async join(channel: string, replies: 'voice' | 'text'): Promise<void> {
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
    const session: Session = { channel, connection, abort, player, audio, replies, busy: false, turn: undefined, cue: undefined, refresh, fail, stop: () => {
      abort.abort(); clearTimeout(idle); if (session.turn) this.endTurn(session, session.turn); player.stop(true);
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
      let posted = false;
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
        await this.poster.reply({ user, server: this.server, channel, text: transcript.slice(0, 2000), kind: 'voice' });
        posted = true;
      })().catch(fail).finally(() => { if (!posted) this.endTurn(session, turn); });
    });
    try { await entersState(connection, VoiceConnectionStatus.Ready, 20_000); }
    catch (error) { if (this.session === session) this.leave(); throw error; }
  }

  /** Reads the bot's reply aloud. Sentences already spoken as the model streamed them are not spoken again. */
  async speak(channel: string, text: string): Promise<void> {
    const session = this.session, turn = session?.turn;
    if (!session || session.channel !== channel || !turn) return;
    if (session.replies === 'text') { this.endTurn(session, turn); session.refresh(); return; }
    try {
      const speech = turn.speech;
      // Nothing was streamed (an error reply, or no sentence): speak the whole reply once.
      if (!speech.streamed) {
        const said = spokenText(text);
        if (said) this.queueSpeech(session, turn, said);
      }
      await speech.settled();
      speech.end();
      await sleepUntil(speech.playEndsAt, session.abort.signal);
      // Silence padding is not in the estimate. Wait until the player has really finished.
      if (session.player.state && session.player.state.status !== AudioPlayerStatus.Idle) await entersState(session.player, AudioPlayerStatus.Idle, AbortSignal.any([session.abort.signal, AbortSignal.timeout(60_000)])).catch(() => undefined);
      if (session.turn !== turn) return;
      this.endTurn(session, turn);
      session.refresh();
    } catch (error) { session.fail(error); this.endTurn(session, turn); }
  }

  /** Plays a short cue while the bot works. Once per turn; the clip is made once per session. Text sessions play nothing. */
  async cue(channel: string): Promise<void> {
    const session = this.session, turn = session?.turn;
    if (!session || session.channel !== channel || !turn || turn.cued || session.replies === 'text') return;
    turn.cued = true;
    const instructions = this.instructions();
    let cue = session.cue;
    if (!cue || cue.instructions !== instructions) {
      const clip = session.audio.speak(VOICE_CUE_TEXT, session.abort.signal, instructions).then(async pcm => {
        // Thunder is billed at $10/1M characters.
        await this.usage.limiter.record(turn.user, Array.from(VOICE_CUE_TEXT).length * 10);
        return pcm;
      });
      cue = { instructions, clip };
      session.cue = cue;
      clip.catch(() => { if (session.cue === cue) session.cue = undefined; });
    }
    const clip = cue.clip;
    // The cue goes in the turn's stream, before any sentence. A failed cue is reported, and the reply still plays.
    turn.speech.queue(async write => {
      const pcm = await clip.catch(error => { session.fail(error); });
      if (pcm) write(pcm);
    });
    await turn.speech.settled();
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
    const run: RunState = { turn, splitter: new SentenceSplitter(), head: '', mode: 'undecided' };
    this.runs.set(event.runId, run);
    return run;
  }

  private runText(session: Session, run: RunState, text: string): void {
    if (run.mode === 'skip') return;
    if (run.mode === 'undecided') {
      run.head += text;
      if (!this.decide(run, false)) return;
      text = run.head; run.head = '';
    }
    if (run.mode === 'stream') this.queueSentences(session, run.turn, run.splitter.push(text));
  }

  private endRun(session: Session, run: RunState): void {
    if (run.mode === 'undecided') this.decide(run, true);
    if (run.mode === 'stream') this.queueSentences(session, run.turn, [...run.splitter.push(run.head), ...run.splitter.flush()]);
    run.head = '';
  }

  /** Decides from the start of a reply whether it is read aloud. An error code is not read; the fallback speaks the error text. */
  private decide(run: RunState, final: boolean): boolean {
    const head = run.head.trimStart();
    // A "[" might start an error code. Wait for the closing "]" or for enough text.
    if (!final && (!head || (/^\\?\[/.test(head) && !head.includes(']') && head.length < 40))) return false;
    run.mode = isErrorReply(run.head) ? 'skip' : 'stream';
    return true;
  }

  private queueSentences(session: Session, turn: Turn, sentences: string[]): void {
    for (const sentence of sentences) {
      const speech = turn.speech;
      if (speech.capped) return;
      let said = plainSpoken(sentence);
      const room = VOICE_SPOKEN_MAX - speech.spokenChars;
      if (Array.from(said).length > room) { said = cutSpoken(said, room); speech.capped = true; }
      if (!said) continue;
      speech.spokenChars += Array.from(said).length;
      speech.streamed = true;
      this.queueSpeech(session, turn, said);
    }
  }

  /** One TTS request for `text`, streamed into the turn's speech. Thunder is billed per character, to the turn user. */
  private queueSpeech(session: Session, turn: Turn, text: string): void {
    const speech = turn.speech;
    speech.queue(async write => {
      if (await this.usage.overGrace({ server: this.server, user: turn.user })) { speech.capped = true; return; }
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
    const turn: Turn = { user, cued: false, speech: new TurnSpeech(session.player, session.abort.signal, error => session.fail(error)), timer: setTimeout(() => this.endTurn(session, turn), VOICE_TURN_TIMEOUT_MS) };
    turn.timer.unref();
    session.busy = true; session.turn = turn;
    return turn;
  }

  private endTurn(session: Session, turn: Turn): void {
    if (session.turn !== turn) return;
    clearTimeout(turn.timer); session.turn = undefined; session.busy = false;
    turn.speech.close();
    for (const [id, run] of this.runs) if (run.turn === turn) this.runs.delete(id);
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
  leave(): void { const session = this.session; this.session = undefined; session?.stop(); if (session) this.onSession?.(undefined, session.channel); }
  stop(): void { this.leave(); this.client.off(Events.VoiceStateUpdate, this.onVoiceState); this.unlisten(); }
}
