import { Readable } from 'node:stream';
import OpusScript from 'opusscript';
import { ChannelType, Events, PermissionFlagsBits, type Client } from 'discord.js';
import { AudioPlayerStatus, EndBehaviorType, NoSubscriberBehavior, StreamType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, type AudioReceiveStream, type VoiceConnection } from '@discordjs/voice';
import type { Config } from '../config.js';
import type { LLM } from '../ports.js';
import { ToolError, type ToolRegistry } from '../tools.js';
import { errorReply, logError } from '../errors.js';
import type { UsageMeter } from '../usage-meter.js';
import { VoiceConversation } from '../voice-conversation.js';
import { PmAudio } from './audio.js';

const MAX_AUDIO_BYTES = 30 * 192000;
const IDLE_MS = 5 * 60_000;

export class DiscordVoice {
  private session: { channel: string; connection: VoiceConnection; abort: AbortController; stop(): void } | undefined;
  private readonly onVoiceState: (old: import('discord.js').VoiceState, next: import('discord.js').VoiceState) => void;

  constructor(private readonly client: Client, private readonly server: string, private readonly config: Config, private readonly llm: LLM, private readonly usage: UsageMeter, private readonly muted: (user: string) => boolean, private readonly connect: typeof joinVoiceChannel = joinVoiceChannel) {
    this.onVoiceState = (_old, next) => {
      if (next.guild.id !== server || !this.session) return;
      if (next.id === client.user?.id && next.channelId !== this.session.channel) { this.leave(); return; }
      const channel = next.guild.channels.cache.get(this.session.channel);
      if (channel?.type === ChannelType.GuildVoice && !channel.members.some(member => !member.user.bot)) this.leave();
    };
    client.on(Events.VoiceStateUpdate, this.onVoiceState);
  }

  register(registry: ToolRegistry): void {
    registry.register({ name: 'voice', description: 'Join your voice channel to talk, leave it, or show voice status', scope: 'discord',
      fields: { action: { type: 'string', description: 'Voice session action', choices: ['join', 'leave', 'status'], required: true } },
      access: 'member', effect: 'write', execution: 'inline', retrySafe: true,
      resource: () => `voice:${this.server}`, writes: args => args.action !== 'status',
      execute: async ({ message, isAdmin }, args) => {
        if (args.action === 'status') return this.session ? `Voice session in <#${this.session.channel}>.` : 'No active voice session.';
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
        await channel.send({ content: 'Slopbot is joining to listen and reply aloud. Human speech is sent to PMServers for transcription, and replies use its chat and speech models. Audio and conversation history stay in memory for this session. I handle one speaker at a time and pause listening while replying. Use /slopbot voice action:leave to stop.', allowedMentions: { parse: [] } });
        await this.join(channel.id);
        return `Joined <#${channel.id}>. I listen to human speakers and reply aloud, one turn at a time. Voice audio and conversation history stay in memory and are sent to PMServers for processing. Use /slopbot voice action:leave to stop. I leave after five minutes of inactivity.`;
      },
    });
  }

  private async join(channel: string): Promise<void> {
    const guild = await this.client.guilds.fetch(this.server);
    const connection = this.connect({ guildId: guild.id, channelId: channel, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    const abort = new AbortController(), captures = new Set<AudioReceiveStream>();
    const conversation = new VoiceConversation(new PmAudio(this.config.baseUrl, this.config.apiKey, this.config.voice?.voice ?? 'alloy'), this.llm, this.usage, this.server);
    let busy = false, idle: ReturnType<typeof setTimeout>;
    const refresh = () => { clearTimeout(idle); idle = setTimeout(() => this.leave(), IDLE_MS); idle.unref(); };
    const session = { channel, connection, abort, stop: () => {
      abort.abort(); clearTimeout(idle); player.stop(true);
      for (const capture of captures) capture.destroy();
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    } };
    this.session = session;
    refresh();
    connection.subscribe(player);
    let lastError = 0;
    const fail = (error: unknown) => {
      if (abort.signal.aborted) return;
      logError('discord_voice_failed', error, { server: this.server, channel });
      const target = guild.channels.cache.get(channel);
      if (Date.now() - lastError > 30_000 && target?.isSendable()) {
        lastError = Date.now();
        void target.send({ content: `Voice conversation failed. ${errorReply(error)}`, allowedMentions: { parse: [] } }).catch(error => logError('discord_voice_notice_failed', error, { server: this.server, channel }));
      }
    };
    connection.on('error', error => { fail(error); if (this.session === session) this.leave(); });
    player.on('error', fail);
    connection.on(VoiceConnectionStatus.Destroyed, () => { if (this.session === session) this.leave(); });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Allow the library to reconnect, but release a kicked or broken connection promptly.
      void entersState(connection, VoiceConnectionStatus.Ready, 5000).catch(() => { if (this.session === session) this.leave(); });
    });
    connection.receiver.speaking.on('start', user => {
      if (busy || abort.signal.aborted || this.muted(user)) return;
      busy = true;
      void (async () => {
        // Subscribe at the speaking event; a REST fetch here can lose the first words.
        const member = guild.members.cache.get(user);
        if (!member || member.user.bot || member.voice.channelId !== channel || abort.signal.aborted) return;
        refresh();
        const pcm = await this.capture(connection, user, captures, abort.signal);
        if (pcm.length < 19200 || member.voice.channelId !== channel || this.muted(user)) return;
        const speech = await conversation.reply(user, member.displayName, pcm, AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]));
        if (!speech || abort.signal.aborted) return;
        player.play(createAudioResource(Readable.from([speech]), { inputType: StreamType.Raw }));
        await entersState(player, AudioPlayerStatus.Playing, 5000);
        await entersState(player, AudioPlayerStatus.Idle, abort.signal);
        refresh();
      })().catch(fail).finally(() => { busy = false; });
    });
    try { await entersState(connection, VoiceConnectionStatus.Ready, 20_000); }
    catch (error) { if (this.session === session) this.leave(); throw error; }
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

  leave(): void { const session = this.session; this.session = undefined; session?.stop(); }
  stop(): void { this.leave(); this.client.off(Events.VoiceStateUpdate, this.onVoiceState); }
}
