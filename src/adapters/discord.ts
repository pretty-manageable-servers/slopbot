import { LocalDiskStorage } from "../web-chat-images.js";
import { contextChangedError, legacyToolProgress, sourceFingerprint, stableAttachmentUrl, toolProgressFooter } from "../source-context.js";
import { errorReply, logError } from "../errors.js";
import { sandboxTool, readSandboxFile } from "../sandbox.js";
import { objectStorageTool, UserFileStorage, MAX_STORED_FILE_BYTES, fileStorageScope } from '../object-storage.js';
import { sendStoredFile } from './discord-storage.js';
import { S3StorageProvider } from './s3-storage.js';
import { programTool } from '../program-tools.js';
import { McpManager, McpSecrets } from '../mcp.js';
import { remoteMcpConnector } from './mcp-client.js';
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { requestTimings, savedTimingFooter } from "../request-timing.js";
import { registerTimingTools, saveRequestTiming } from "../timing-tools.js";
import {handleDiscordUi} from './discord-ui-interactions.js';
import {registerTaskTools} from '../productivity/tasks.js';
import {registerReminderTools,ReminderWorker} from '../productivity/reminders.js';
import {registerReportTools} from '../search/reports.js';
import {UiRuntime,registerUiTool,registerPollTool} from '../ui/runtime.js';
import type {UiDocument} from '../ui/schema.js';
import {discordUi} from './discord-ui.js';
import { DiscordToolProgress } from './discord-tool-progress.js';
import { toolFooter, toolDisplayMode } from '../presentation/tool-activity.js';
import type { ToolActivity } from '../tool-activity.js';
import { discordPresentation, suppressLinkPreviews } from '../presentation/discord.js';
import { registerHistoryTools } from '../search/history-search.js';
import { registerWebSearch } from "../web-search.js";
import { registerWebFetch } from "../web-fetch.js";
import { FallbackFetch, FallbackSearch, LimiterWebCharge, StoreKeyPool } from "../web-chain.js";
import { WebKeySecrets } from "../web-keys.js";
import { TavilySearch } from "./tavily.js";
import { FirecrawlScrape, FirecrawlSearch } from "./firecrawl.js";
import { PlainFetch } from "./plain-fetch.js";
import { SearxNGSearch } from "./searxng.js";
import { ReplyRenderer } from "../reply-renderer.js";
import { registerFileTool, inspectFile } from '../files.js';
import {
  Client, Events, GatewayIntentBits, Partials, ThreadAutoArchiveDuration,
  MessageFlags, PermissionFlagsBits, ChannelType, ActivityType,
  type ChatInputCommandInteraction, type Interaction, type Message as DiscordMessage, type PartialMessage,
} from "discord.js";
import { BOT_REPLY_LIMIT_KEY, botReplyLimit } from "../bot-reply-limit.js";
import { GLOBAL_SETTINGS_SCOPE } from "../usage-cost.js";
import { buildStopCommand, buildToolCommands, buildUsageCommand, usageReply } from "./discord-commands.js";
import { registerProfileTools } from "../profiles.js";
import { Application } from "../application.js";
import { Bot, splitReply, type ChatGateway, type Incoming } from "../bot.js";
import { PresenceUpdater } from "../presence.js";
import type { Config } from "../config.js";
import { parseEffort, type Message } from "../domain.js";
import type { LLM } from "../ports.js";
import type { RuntimeStore } from "../runtime-store.js";
import { LLMClassifier, ParticipationGate } from "../participation.js";
import { HistoryImporter } from "../history.js";
import { DecisionClassifier } from "./decisions.js";
import { TaskWorker } from "../queue.js";
import { UserLimiter, UserLimitError, limitReply, usageView } from "../user-limiter.js";
import { createUsageMeter, type UsageMeter } from "../usage-meter.js";
import { registerUsageTool } from "../usage-tools.js";
import { configuredChannels, registerServerTools, webTranscriptKey, webTranscriptsEnabled } from "../server-tools.js";
import { pageItems, type ServerListRow, type ServerPage } from "../admin-panel.js";
import { ChannelAccess } from "../channel-access.js";
import { TeamAdmins, discordTeamSource } from "../team-admins.js";
import { publishMessage, publishMessageDelete, publishTool, runEvents } from "../run-events.js";
import { ShareService, type ShareRule } from "../shares.js";
import { discordChannelAccessSource, wireChannelAccessEvents } from "./discord-channel-access.js";
import { displayToolResult, ToolError, ToolRegistry, UncertainActionError, stableOperationId } from "../tools.js";
import { WebReplies, asWebUser, webReplyKey } from "../web-replies.js";
import { MemberDirectory, discordMemberSource } from "../member-directory.js";
import { discordWebReplies } from "./discord-web-replies.js";
import { isPrivateChannel } from "../private-chat.js";
import { registerOperationsTools } from '../operations.js';
import { HttpOperationsClient } from './operations-client.js';
import { FixWatchWorker } from '../fix-watch-worker.js';
import { WebChatGateway, type ChatHost } from "../web-chats.js";

/** Slopbot state and services for one Discord server. All servers share one client. */
interface TranscriptChannel { id: string; name: string; enabled: boolean }

export class DiscordServer implements ChatGateway {
  private readonly client: Client;
  private readonly bot: Bot;
  private readonly app: Application;
  private readonly renderer: ReplyRenderer;
  private readonly reminders: ReminderWorker;
  private readonly fixWatches: FixWatchWorker | undefined;
  private readonly uiRuntime: UiRuntime;
  private readonly toolProgress = new DiscordToolProgress();
  private readonly tools: ToolRegistry;
  private readonly mcp: McpManager;
  private readonly worker: TaskWorker;
  private readonly limiter: UserLimiter;
  private readonly history: HistoryImporter;
  private readonly webReplies: WebReplies;
  // Replies in private chats. They are saved in the database and never sent to Discord.
  private readonly chatGateway: WebChatGateway;
  private channels: string[];
  private historyTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: Config, private readonly store: RuntimeStore, llm: LLM, client: Client, readonly guildId: string, objectStorageProvider: S3StorageProvider | undefined, usage: UsageMeter = createUsageMeter(config, store), access: ChannelAccess = new ChannelAccess(discordChannelAccessSource(client)), private readonly members?: Pick<MemberDirectory, "profiles">, private readonly team?: Pick<TeamAdmins, "canEdit">) {
    this.client = client;
    this.renderer = new ReplyRenderer(store, discordPresentation);
    this.chatGateway = new WebChatGateway(store, guildId);
    this.channels = configuredChannels(config, store, guildId);
    this.history = new HistoryImporter(guildId, store, {
      fetch: async (channel, before, limit) => {
        if (!this.channels.includes(channel)) throw new ToolError("Channel is no longer configured");
        const target = await this.client.channels.fetch(channel);
        if (!target || target.type !== ChannelType.GuildText || target.guildId !== guildId) throw new ToolError("Text channel unavailable");
        const batch = await target.messages.fetch({ limit, ...(before ? { before } : {}) });
        return [...batch.values()].sort((a, b) => a.id === b.id ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1)
          .map(message => ({ ...this.normalize(message), addressed: false }));
      },
    }, config.historyWindowDays);
    const savedLimit = (key: string, fallback: number, max: number): number => {
      const value = store.setting(guildId, key);
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
    };
    const savedMonitoring = store.setting(guildId, "monitoring");
    const participation = new ParticipationGate(new DecisionClassifier({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.jevModel, usage }, store, undefined, new LLMClassifier(llm, store, usage)), {
      enabled: (typeof savedMonitoring === "boolean" ? savedMonitoring : config.jevEnabled) && !config.mock,
      reactionFrequency: savedLimit("reaction_frequency", store.setting(guildId, "reactions_enabled") === false ? 0 : 60, 100),
      contextMessages: savedLimit("classifier_context", config.jevContextMessages, 100),
      cooldownMs: savedLimit("cooldown_seconds", config.jevCooldownSeconds, 3600) * 1000,
      maxUnsolicitedPerHour: savedLimit("max_unsolicited_per_hour", config.jevMaxRepliesPerHour, 1000),
    });
    this.tools = new ToolRegistry(store, async message => {
      if (message.server !== guildId) return false;
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch({ user: message.author, force: true });
      return member.permissions.has(PermissionFlagsBits.ManageGuild);
    }, async (context, expectedVersion) => {
      if (context.source !== "agent") return;
      const message = context.message, source = (await store.canonicalMessage(message.server, message.id));
      if (!source || source.text !== message.text || !this.bot.accepts(message.server, message.channel)) throw new ToolError("Source or channel changed before the action");
      if (expectedVersion !== undefined && expectedVersion !== await store.contextVersion(message.server, message.channel)) throw contextChangedError(message, await store.lastContextChange?.(message.server, message.channel), { expectedVersion, actualVersion: await store.contextVersion(message.server, message.channel) });
      if (this.tools.effect(context.toolName, context.arguments) === "write" && context.toolName !== "task_retry") {
        if ((await store.hasBlocked(message.server, message.channel))) throw new ToolError("This task has an uncertain action; reconcile it before new writes");
        if (message.taskId && (await store.hasPendingOther(message.server, message.channel, message.id))) throw new ToolError("New contributions are queued; review them before further actions");
      }
    });
    this.mcp = new McpManager(guildId, store, this.tools, remoteMcpConnector({ allowPrivate: process.env.MCP_ALLOW_PRIVATE === 'true' }), new McpSecrets(process.env.MCP_SECRET_KEY), message => this.validateChannel(message, message.channel));
    registerServerTools(this.tools, {
      config, server: guildId, store, participation, history: this.history,
      isTeamEditor: async user => team ? await team.canEdit(user).catch(() => false) : false,
      channels: () => this.channels,
      setChannels: channels => this.setChannels(channels),
      findChannels: async (message, query) => {
        const guild = await this.client.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        const found: string[] = [];
        for (const channel of channels.values()) {
          if (channel?.type !== ChannelType.GuildText || !channel.name.toLowerCase().includes(query.replace(/^#/, "").toLowerCase())) continue;
          try { await this.validateChannel(message, channel.id); found.push(`${channel.name}: <#${channel.id}>`); } catch (error) { if (!(error instanceof ToolError)) throw error; }
          if (found.length === 20) break;
        }
        return found.join("\n") || "No matching channels visible to you and Slopbot.";
      },
      validateChannel: (message, channel, parentOnly) => this.validateChannel(message, channel, parentOnly),
      accepts: channel => this.bot.accepts(guildId, channel),
      setReplyContext: count => this.app.setRecentMessages(count),
      originMessage: async message => message.id.startsWith("task-seed:") ? (await store.canonicalMessage(message.server, message.id.slice(10))) ?? message : message,
      startTask: (message, goal) => this.bot.startTask(message, goal),
      reconcileTask: async message => {
        const registered = (await store.taskForSource(message.server, message.id));
        if (registered) { await this.bot.startTask(message, message.text); return registered; }
        const channel = await this.client.channels.fetch(message.channel);
        if (channel?.type !== ChannelType.GuildText || message.id.startsWith("command:")) return undefined;
        const source = await channel.messages.fetch(message.id);
        if (!source.hasThread) return undefined;
        const thread = (source.thread ?? await channel.threads.fetch(source.id));
        if (!thread || thread.ownerId !== this.client.user?.id) return undefined;
        (await store.registerTask(guildId, thread.id, message.channel, message.id));
        await this.bot.startTask(message, message.text);
        return thread.id;
      },
      wakeWorker: () => this.worker.wake(),
    });
    const authorizeFeature = async(message:Message,channel:string) => {
      if(!this.bot.accepts(message.server,channel))throw new ToolError('Channel is disabled.');
      await this.validateChannel(message,channel);
    };
    this.uiRuntime = new UiRuntime(store,this.tools,authorizeFeature);
    registerTimingTools(this.tools, { store, authorize: authorizeFeature });
    if (config.operations?.servers.includes(guildId)) {
      const operations = registerOperationsTools(this.tools, { store, config: config.operations, client: new HttpOperationsClient(config.operations), authorize: authorizeFeature });
      this.fixWatches = new FixWatchWorker(guildId, operations, async message => {
        await authorizeFeature(message, message.channel);
        await this.tools.checkAccess(message, 'fix_watch');
      }, async (message, text, id) => { await this.reply(message, text, id); });
    }
    registerHistoryTools(this.tools,{store,authorize:authorizeFeature});
    registerReportTools(this.tools,{store,llm,authorize:authorizeFeature,usage});
    registerPollTool(this.tools);
    registerTaskTools(this.tools,{store,authorize:authorizeFeature});
    registerReminderTools(this.tools,{store,authorize:authorizeFeature});
    this.reminders=new ReminderWorker(guildId,store,async(message,text,id)=>{await this.reply(message,text,id);},authorizeFeature);
    registerUiTool(this.tools);
    registerProfileTools(this.tools, store);
    // Free steps first. Team keys from the admin panel are used only when the free step fails.
    const webKeys = new WebKeySecrets();
    const pool = webKeys.enabled ? new StoreKeyPool(store, row => webKeys.open(row.secretEncrypted, row.id)) : undefined;
    const charge = new LimiterWebCharge(usage.limiter, store);
    registerWebSearch(this.tools, new FallbackSearch({ ...(config.searxngUrl ? { searxng: new SearxNGSearch(config.searxngUrl, fetch, Date.now, config.searxngAccess) } : {}), ...(pool ? { pool, tavily: new TavilySearch(), firecrawl: new FirecrawlSearch() } : {}), charge }));
    registerWebFetch(this.tools, new FallbackFetch({ plain: new PlainFetch(), ...(pool ? { pool, firecrawl: new FirecrawlScrape() } : {}), charge }));
    const resolveAttachment = async (request: Message, requestedId: string | undefined, allowParent = false): Promise<Message> => {
      const id = requestedId ?? (request.attachments?.length ? request.id : request.replyTo);
      if (!id) throw new ToolError("Reply to a message with a file attached.");
      const known = (await store.canonicalMessage(request.server, id));
      const parent = allowParent ? store.taskThreads(request.server).find(task => task.thread === request.channel)?.parent : undefined;
      if (!known || (known.channel !== request.channel && known.channel !== parent) || !this.bot.accepts(request.server, known.channel)) throw new ToolError("File source must be in this permitted channel or the task's permitted parent channel.");
      if (isPrivateChannel(known.channel)) throw new ToolError("Files in private chats are not available yet.");
      await this.validateChannel(request, known.channel);
      const channel = await this.client.channels.fetch(known.channel);
      if (!channel || !channel.isTextBased() || !("messages" in channel)) throw new ToolError("Source channel unavailable");
      const fresh = this.normalize(await channel.messages.fetch(id));
      if (sourceFingerprint(fresh) !== sourceFingerprint(known)) { await this.store.revise(fresh); throw contextChangedError(request, { reason: "file_source_changed", sourceId: id }); }
      return fresh;
    };
    registerFileTool(this.tools, { store, llm, resolve: resolveAttachment, usage });
    const sandboxProvider = config.sandboxApiKey ? new E2BSandboxProvider({ apiKey: config.sandboxApiKey, apiUrl: config.sandboxApiUrl!, sandboxUrl: config.sandboxUrl!, ...(config.sandboxTemplate ? { template: config.sandboxTemplate } : {}) }) : undefined;
    const storage = new UserFileStorage(store, objectStorageProvider);
    this.tools.register(sandboxTool(store, sandboxProvider, { resolve: (request, id) => resolveAttachment(request, id, true) }, storage));
    this.tools.register(objectStorageTool({
      storage,
      authorize: message => authorizeFeature(message, message.channel),
      resolveAttachment: (request, id) => resolveAttachment(request, id, true),
      inspect: (context, file, bytes, question) => inspectFile({ store, llm, usage, assertCurrent: async () => { const current = await storage.entry(context.message.server, context.message.author, file.owner, file.path, false, fileStorageScope(file), context.isAdmin); if (current.file.key !== file.key) throw new ToolError('Stored file changed during inspection. Read its current version.'); } }, context, file.path, file.contentType, bytes, question),
      send: async (context, file, bytes) => {
        const current = await storage.entry(context.message.server, context.message.author, file.owner, file.path, false, fileStorageScope(file), context.isAdmin);
        if (current.file.key !== file.key) throw new ToolError('Stored file changed before sending. Request its current version.');
        await sendStoredFile(this.client, context, file, bytes);
      },
      ...(sandboxProvider ? { sandbox: {
        read: (context, path) => readSandboxFile(store, sandboxProvider, context, path, MAX_STORED_FILE_BYTES),
        write: async (context, path, _bytes) => {
          const output = await this.tools.invokeResult(context.message, 'sandbox', { action: 'import_storage', path, storage_path: context.arguments.path!, ...(context.arguments.storage_scope ? { storage_scope: context.arguments.storage_scope } : {}), ...(context.arguments.owner ? { owner: context.arguments.owner } : {}) }, `${context.operationId}:sandbox-import`, context.source);
          if (output.status === 'failed' || output.status === 'rejected') throw new ToolError(output.reason ?? output.text, output.status);
        },
      } } : {}),
    }));
    this.limiter = usage.limiter;
    this.webReplies = new WebReplies({
      store, discord: discordWebReplies(client), access, limiter: this.limiter, secret: webReplyKey(),
      enabled: parent => webTranscriptsEnabled(store, guildId, parent),
      accepts: channel => this.bot.accepts(guildId, channel),
    });
    registerUsageTool(this.tools, this.limiter);
    this.tools.register(programTool(this.tools));
    this.app = new Application(store, llm, {
      allowedChannels: this.channels.map(channel => ({ server: guildId, channel })),
      recentMessages: savedLimit("reply_context", config.replyContextMessages, 100),
      maxContextTokens: config.contextTokens, maxInputChars: config.contextTokens,
      maxOutputTokens: config.outputTokens, checkpointTokens: config.checkpointTokens, maxToolRounds: config.maxToolRounds,
    }, store, { usage, onToolActivity: async (message, activity) => {
      if (!this.bot.accepts(message.server, message.channel)) return;
      publishTool(message, activity);
      // A private chat shows tool progress in its own stream, not in Discord.
      if (isPrivateChannel(message.channel)) return;
      await this.toolProgress.update(JSON.stringify([message.server,message.channel,message.id]), activity, async content => {
        const channel = await this.client.channels.fetch(message.channel);
        if (!channel?.isTextBased() || !channel.isSendable()) throw new ToolError("Status channel unavailable");
        return channel.send({content,embeds:[{footer:{text:toolProgressFooter}}],...(!message.id.startsWith("task-seed:") && !message.id.startsWith("command:") ? {reply:{messageReference:message.id,failIfNotExists:false}} : {}),allowedMentions:{parse:[],repliedUser:false}});
      });
    }, presentation: discordPresentation, profiles: store, harness: store, tools: {
      catalog: message => this.tools.catalog(message), schemas: message => this.tools.schemas(message), suggest: message => this.tools.suggest(message),
      execute: (message, call, id, version, invocation) => this.bot.executeTool(message, call, id, version, invocation),
      snapshot: () => {
        const selected = this.tools.capture();
        return { catalog: selected.catalog, schemas: selected.schemas, suggest: selected.suggest, execute: (message, call, id, version, invocation) => {
          selected.assertCurrent(call.name);
          return this.bot.executeTool(message, call, id, version, { ...invocation, assertTool: selected.assertCurrent });
        } };
      },
    } });
    this.worker = new TaskWorker(guildId, store, this.limiter, async message => {
      const source = (await store.canonicalMessage(message.server, message.id));
      if (!source || source.text !== message.text || source.author !== message.author) throw new Error("Source changed while queued; submit a new request");
      if (!message.taskId && /^!task(?:\s|$)/i.test(message.text)) {
        const goal = message.text.replace(/^!task\s*/i, "").trim();
        if (!goal) throw new ToolError("Use !task followed by the task goal");
        const operationId = `task-start:${message.server}:${message.id}`;
        const result = await this.tools.invoke(message, "task_start", { goal }, operationId, "command");
        return { runId: operationId, text: result, contextVersion: await store.contextVersion(message.server, message.channel) };
      }
      const stop = this.typing(message.channel);
      try { return await this.app.handle(message, true); } finally { stop(); }
    }, (message, reply, id) => this.bot.deliver(message, reply, id), message => this.bot.accepts(message.server, message.channel), 3, async (job, error) => {
      if (!this.bot.accepts(job.message.server, job.message.channel)) return;
      await this.reply(job.message, errorReply(error, job.id), `job-error:${job.id}`);
    });
    this.bot = new Bot(this.app, store, store, this, guildId, this.channels, { profiles: store, knowledge: store, participation, worker: this.worker, tools: this.tools, queueStore: store, botReplyLimit: () => botReplyLimit(store.setting(GLOBAL_SETTINGS_SCOPE, BOT_REPLY_LIMIT_KEY)) });
  }
  /** Private chats: the chat service opens, closes and hands messages in through these. */
  openChat(channel: string): void { this.bot.openPrivateChat(this.guildId, channel); }
  closeChat(channel: string): void { this.bot.closePrivateChat(this.guildId, channel); }
  async receiveChat(message: Message): Promise<void> {
    // The chat service saves the message first, so the bot must not save it again.
    await this.bot.receive({ ...message, botAuthor: false, mentionsBot: false, repliesToBot: false }, { ingested: true });
  }
  /** Starts work for this server after the client is ready. */
  async ready(botUser: string): Promise<void> {
    await this.store.setSetting(this.guildId, "context_bot_author", botUser);
    if (!this.channels.length) console.warn(`No channels configured for server ${this.guildId}. Use /slopbot channels action:add channel:<channel> to enable replies.`);
    void this.purgeAndIndex().catch(error => logError("Database startup indexing failed", error, { server: this.guildId }));
    void this.hydrateAuthors().catch(error => logError("Author-name refresh unavailable; names will fill from new messages.", error, { server: this.guildId }));
    // Reopens the private chats of this server, so a restart keeps them answering.
    for (const channel of await this.store.liveWebChatChannels(this.guildId)) this.bot.openPrivateChat(this.guildId, channel);
    this.worker.start();
    const sync = () => { for (const channel of this.channels) void this.history.start(channel).catch(error => logError("History import startup failed", error, { server: this.guildId })); };
    this.reminders.start();
    this.fixWatches?.start();
    sync(); this.historyTimer = setInterval(sync, 60000);
    void this.registerCommands().catch(error => logError("Could not register /slopbot, /usage and /stop commands. Check application command permissions.", error, { server: this.guildId }));
  }
  interaction(interaction: Interaction): void {
    if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('slopui:')) {
      void handleDiscordUi(interaction,this.uiRuntime).catch(error => logError('UI interaction display failed.', error));
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "slopbot") void this.command(interaction).catch(error => logError("Command failed.", error));
    if (interaction.isChatInputCommand() && interaction.commandName === "usage") void this.usageCommand(interaction).catch(error => logError("Command failed.", error));
    if (interaction.isChatInputCommand() && interaction.commandName === "stop") void this.stopCommand(interaction).catch(error => logError("Command failed.", error));
  }
  messageCreate(message: DiscordMessage): void { void this.receive(message).catch(error => logError("Discord event failed. Check channel permissions.", error)); }
  messageUpdate(updated: DiscordMessage | PartialMessage): void {
    void (async () => {
      if (!updated.guildId || !this.bot.accepts(updated.guildId, updated.channelId)) return;
      const message = updated.partial ? await updated.fetch() : updated;
      const normalized = this.normalize(message);
      await this.store.revise(normalized);
      if (!normalized.transient) await publishMessage(this.store, normalized, undefined, this.members).catch(error => logError("web_transcript_publish_failed", error, { server: this.guildId }, true));
    })().catch(error => logError("Could not update edited message context.", error));
  }
  messageDelete(message: { guildId: string | null; channelId: string; id: string }): void {
    if (message.guildId && this.bot.accepts(message.guildId, message.channelId)) void this.store.remove(message.guildId, message.channelId, message.id).then(() => publishMessageDelete(message.guildId!, message.channelId, message.id)).catch(error => logError("discord_message_delete_failed", error, { messageId: message.id }));
  }
  private async purgeAndIndex(): Promise<void> {
    const children = this.store.taskThreads(this.guildId).filter(task => this.channels.includes(task.parent)).map(task => task.thread);
    const scopes = [...this.channels, ...children];
    await this.store.purgeUnconfigured(this.guildId, scopes); await this.store.reindex(this.guildId, scopes);
  }
  private async setChannels(channels: string[]): Promise<void> {
    const previous = this.channels;
    this.channels = [...channels]; this.bot.setChannels(channels);
    for (const channel of previous) if (!channels.includes(channel)) await this.history.exclude(channel);
    await this.purgeAndIndex();
    for (const channel of channels) if (!previous.includes(channel)) await this.history.include(channel);
  }
  private async validateChannel(message: Message, channelId: string, parentOnly = false): Promise<void> {
    // A private chat may use only its own channel. A Discord message may never use a private chat.
    if (isPrivateChannel(channelId) || isPrivateChannel(message.channel)) {
      if (channelId !== message.channel || !isPrivateChannel(channelId)) throw new ToolError("Choose a text channel in this server.");
      return;
    }
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(channel.type === ChannelType.GuildText || (!parentOnly && channel.isThread())) || channel.guildId !== message.server || message.server !== this.guildId) throw new ToolError("Choose a text channel in this server.");
    const guild = await this.client.guilds.fetch(message.server);
    const member = await guild.members.fetch({ user: message.author, force: true });
    const bot = await guild.members.fetchMe();
    const permission = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
    if (!channel.permissionsFor(member)?.has(permission) || !channel.permissionsFor(bot)?.has(permission)) throw new ToolError("Both you and Slopbot need View Channel and Read Message History permission.");
  }
  private async registerCommands(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.guildId);
    // set() replaces the whole list, so commands from older versions are removed.
    // /usage is a separate command, so /slopbot stays as it is.
    await guild.commands.set([buildToolCommands(this.tools).toJSON(), buildUsageCommand().toJSON(), buildStopCommand().toJSON()]);
    // Slopbot registers no global commands. Old global commands stay visible and fail, so remove them.
    const global = await this.client.application?.commands.fetch();
    if (global?.size) await this.client.application!.commands.set([]);
  }
  /** Stops responses in a channel. The web console calls it too. Manage Server and team editors stop all responses. */
  async stopResponses(channel: string, user: string, manager: boolean): Promise<number> {
    const admin = manager || (this.team ? await this.team.canEdit(user).catch(() => false) : false);
    return this.bot.stop(this.guildId, channel, user, admin);
  }
  /** The /stop command. Stops the Slopbot responses in this channel. */
  private async stopCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.guildId !== this.guildId) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const manager = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
      const stopped = await this.stopResponses(interaction.channelId, interaction.user.id, manager);
      await interaction.editReply({ content: stopped ? `Stopped ${stopped} response${stopped === 1 ? "" : "s"}.` : "No response to stop. You can stop only the responses that you started.", allowedMentions: { parse: [] } });
    } catch (error) {
      logError("command_failed", error, { stage: "stop command", server: this.guildId, messageId: interaction.id });
      await interaction.editReply({ content: errorReply(error), allowedMentions: { parse: [] } });
    }
  }
  /**
   * The /usage command. Read-only, so it never checks the UserLimiter gate: a user over the limit
   * still sees their usage and can use a banked reset. Do not add a limiter check here.
   */
  private async usageCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.guildId !== this.guildId) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const reply = await usageReply(this.limiter, interaction.user.id, interaction.options.getString("reset"));
      await interaction.editReply({ ...(reply.content ? { content: reply.content } : {}), embeds: reply.embeds, allowedMentions: { parse: [] } });
    } catch (error) {
      logError("command_failed", error, { stage: "usage command", server: this.guildId, messageId: interaction.id });
      await interaction.editReply({ content: errorReply(error), allowedMentions: { parse: [] } });
    }
  }
  private async command(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.guildId !== this.guildId) return;
    let ephemeral = true;
    try {
      const subcommand = interaction.options.getSubcommand();
      const name = subcommand === "run" ? interaction.options.getString("tool", true) : subcommand;
      const definition = this.tools.definitions().find(tool => tool.name === name);
      const args = subcommand === "run" ? JSON.parse(interaction.options.getString("arguments") ?? "{}") : { action: interaction.options.getString("action") ?? "get" };
      ephemeral = !definition?.publicResult?.(args);
    } catch { /* Malformed requests receive private errors. */ }
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    try {
      const subcommand = interaction.options.getSubcommand();
      const name = subcommand === "run" ? interaction.options.getString("tool", true) : subcommand;
      const definition = this.tools.definitions().find(tool => tool.name === name);
      if (!definition) throw new ToolError("Unknown Slopbot tool");
      // The usage tool stays available over the limit, so a user can see their spend and use a reset.
      if (name !== "usage") { const limit = await this.limiter.check(interaction.user.id); if (!limit.allowed) throw new UserLimitError(limit.resetAt); }
      let args: Record<string, unknown> = {};
      if (subcommand === "run") {
        let parsed: unknown;
        try { parsed = JSON.parse(interaction.options.getString("arguments") ?? "{}"); } catch { throw new ToolError("Arguments must be a JSON object"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ToolError("Arguments must be a JSON object");
        args = Object.fromEntries(Object.entries(parsed));
      }
      for (const [key, field] of subcommand === "run" ? [] : Object.entries(definition.fields)) {
        const value = field.type === "boolean" ? interaction.options.getBoolean(key) : field.type === "integer" ? interaction.options.getInteger(key) : field.type === "channel" ? interaction.options.getChannel(key)?.id : interaction.options.getString(key);
        if (value !== undefined && value !== null) {
          if (field.type === "json") { try { args[key] = JSON.parse(String(value)); } catch { throw new ToolError(`Invalid JSON: ${key}`); } }
          else args[key] = value;
        }
      }
      const displayName = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.globalName ?? interaction.user.username;
      const message: Message = { authorName: displayName, authorAliases: [interaction.user.username, ...(interaction.user.globalName ? [interaction.user.globalName] : [])], authorIdentity: { discord_handle: interaction.user.username, discord_name: interaction.user.globalName ?? interaction.user.username, server_nickname: displayName, server_name: interaction.guild?.name ?? "" }, id: `command:${interaction.id}`, server: interaction.guildId, channel: interaction.channelId, author: interaction.user.id, text: `/slopbot ${name} ${JSON.stringify(args)}`, addressed: false, timestamp: Date.now() };
      if (definition.access === "member" && !this.bot.accepts(message.server, message.channel)) throw new ToolError("Use this tool in a configured channel or task thread.");
      if (this.bot.accepts(message.server, message.channel)) await this.store.ingest(message);
      const output = await this.tools.invokeResult(message, name, args, `command:${interaction.id}`, "command");
      const result = displayToolResult(output);
      const parts = splitReply(result);
      const previewFlags = suppressLinkPreviews(result) ? MessageFlags.SuppressEmbeds : 0;
      await interaction.editReply({ content: parts[0] ?? "Done.", ...(previewFlags ? { flags: MessageFlags.SuppressEmbeds } : {}), allowedMentions: { parse: [] } });
      for (const content of parts.slice(1)) await interaction.followUp({ content, flags: previewFlags | (ephemeral ? MessageFlags.Ephemeral : 0), allowedMentions: { parse: [] } });
      if(output.ui){const state=await this.uiRuntime.prepare(message,output.ui,interaction.id);const payload=discordUi(output.ui,state.id,state.revision);await interaction.followUp({...payload,flags:[...('flags' in payload?payload.flags:[]),...(ephemeral?['Ephemeral' as const]:[])],allowedMentions:{parse:[]}});}
    } catch (error) {
      if (error instanceof UserLimitError) { await interaction.editReply({ content: limitReply(error.resetAt), allowedMentions: { parse: [] } }); return; }
      logError("command_failed", error, { stage: "slash command", server: this.guildId, messageId: interaction.id });
      await interaction.editReply({content: errorReply(error), allowedMentions: {parse: []}});
    }
  }
  private async hydrateAuthors(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const authors = (await this.store.knownAuthors(this.guildId)).filter(item => /^\d{17,20}$/.test(item.author));
    let refreshed = 0;
    for (let offset = 0; offset < authors.length; offset += 4) {
      const results = await Promise.allSettled(authors.slice(offset, offset + 4).map(async ({ author }) => {
        const member = await guild.members.fetch(author).catch(() => undefined);
        const user = member?.user ?? await this.client.users.fetch(author);
        await this.store.identifyAuthor(this.guildId, author, [member?.displayName ?? user.globalName ?? user.username, user.username, ...(user.globalName ? [user.globalName] : [])], user.bot, { discord_handle: user.username, discord_name: user.globalName ?? user.username, server_nickname: member?.displayName ?? user.username, server_name: guild.name });
      }));
      refreshed += results.filter(result => result.status === "fulfilled").length;
    }
    console.log(`Author names refreshed: ${refreshed}/${authors.length}; unresolved names can be supplied with Discord mentions.`);
  }
  private normalize(message: DiscordMessage): Message {
    const id = this.client.user?.id;
    const text = id ? message.content.replace(new RegExp(`<@!?${id}>`, "g"), "").trim() : message.content;
    const attachments: import("../domain.js").Attachment[] = [...message.attachments.values()].map(item => ({ name: item.name ?? "file", url: item.url, size: item.size, ...(item.contentType ? { contentType: item.contentType } : {}) }));
    for (const embed of message.embeds) {
      const media = embed.image ?? embed.thumbnail;
      const url = media?.url ?? media?.proxyURL;
      if (url && /\.(gif|png|jpe?g|webp)(?:\?|$)/i.test(url) && !attachments.some(item => item.url === url)) attachments.push({ name: new URL(url).pathname.split('/').pop() ?? 'image.gif', url, size: 0, preview: true });
    }
    const embedText = message.author.bot || message.webhookId
      ? message.embeds.filter(embed => !embed.data?.type || embed.data.type === "rich").map(embed => [embed.title, embed.description, ...embed.fields.map(field => `${field.name}: ${field.value}`)].filter(Boolean).join("\n")).filter(Boolean).join("\n").slice(0, 12000)
      : "";
    const media = attachments.map(item => `[Attachment ${item.name}, type ${'contentType' in item ? item.contentType : 'unknown'}: ${stableAttachmentUrl(item.url)}; content not inspected]`).join("\n");
    const normalized: Message = { attachments, id: message.id, server: message.guildId!, channel: message.channelId, author: message.author.id, authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username, authorAliases: [message.author.username, ...(message.author.globalName ? [message.author.globalName] : [])], isBot: message.author.bot || Boolean(message.webhookId), authorIdentity: { discord_handle: message.author.username, discord_name: message.author.globalName ?? message.author.username, server_nickname: message.member?.displayName ?? message.author.username, server_name: message.guild?.name ?? "" }, text: [text, embedText, media].filter(Boolean).join("\n"), timestamp: message.createdTimestamp, revisionTimestamp: message.editedTimestamp ?? message.createdTimestamp,
      ...(message.reference?.messageId ? { replyTo: message.reference.messageId } : {}) };
    const ownProgress = message.author.id === this.client.user?.id && (message.embeds.some(embed => embed.footer?.text === toolProgressFooter) || legacyToolProgress(normalized));
    return ownProgress ? { ...normalized, transient: true } : normalized;
  }
  private async receive(message: DiscordMessage): Promise<void> {
    if (!message.guildId || !this.bot.accepts(message.guildId, message.channelId)) return;
    if (message.author.id === this.client.user?.id) return this.receiveOwn(message);
    const live = this.normalize(message);
    // Not awaited: a member lookup must not delay the reply.
    if (!live.transient) void publishMessage(this.store, live, undefined, this.members).catch(error => logError("web_transcript_publish_failed", error, { server: this.guildId }, true));
    const timingScope = { server: message.guildId, channel: message.channelId, id: message.id };
    requestTimings.begin(timingScope); requestTimings.start(timingScope, "references");
    await requestTimings.withScope(timingScope, () => this.receiveScoped(message, timingScope));
  }
  /** Slopbot's own messages are ignored, except a bot web reply whose exact returned ID matched. */
  private async receiveOwn(message: DiscordMessage): Promise<void> {
    const server = message.guildId!, channel = message.channelId;
    const web = await this.webReplies.origin({ server, channel, id: message.id }).catch(error => {
      logError("web_reply_origin_failed", error, { stage: "web reply origin", server, channel, messageId: message.id }, true);
      return undefined;
    });
    if (!web) return;
    const base: Incoming = { ...this.normalize(message), botAuthor: false, mentionsBot: this.client.user ? message.mentions.users.has(this.client.user.id) : false, repliesToBot: false };
    await this.bot.receive(asWebUser(base, web));
  }
  private async receiveScoped(message: DiscordMessage, timingScope: { server: string; channel: string; id: string }): Promise<void> {
    let repliesToBot = false;
    let referenced = message;
    const visited = new Set<string>();
    for (let depth = 0; depth < 4 && referenced.reference?.messageId; depth++) {
      if ((referenced.reference.channelId ?? message.channelId) !== message.channelId || visited.has(referenced.reference.messageId)) break;
      visited.add(referenced.reference.messageId);
      try {
        const reference = await requestTimings.wait("Discord reference fetch", () => referenced.fetchReference());
        if (reference.guildId !== message.guildId || reference.channelId !== message.channelId) break;
        if (depth === 0) repliesToBot = reference.author.id === this.client.user?.id;
        const source = { ...this.normalize(reference), addressed: false };
        await this.store.ingest(source);
        await this.store.revise(source);
        referenced = reference;
      } catch { break; } // Missing references grant no access.
    }
    const base: Incoming = { ...this.normalize(message), botAuthor: message.author.bot || Boolean(message.webhookId), mentionsBot: this.client.user ? message.mentions.users.has(this.client.user.id) : false, repliesToBot };
    // Only the exact ID that Slopbot's web post returned counts as the user. The event waits up to 10 s for that post.
    const web = message.webhookId && message.guildId ? await requestTimings.wait("web reply origin", () => this.webReplies.origin({ server: message.guildId!, channel: message.channelId, id: message.id, webhookId: message.webhookId! }).catch(error => {
      logError("web_reply_origin_failed", error, { stage: "web reply origin", server: message.guildId!, channel: message.channelId, messageId: message.id }, true);
      return undefined;
    })) : undefined;
    const incoming: Incoming = web ? asWebUser(base, web) : base;
    requestTimings.end(timingScope, "references");
    await this.bot.receive(incoming);
  }
  async react(message: Message, emoji: string): Promise<void> {
    if (isPrivateChannel(message.channel)) return this.chatGateway.react();
    if (!this.bot.accepts(message.server, message.channel)) return;
    const channel = await requestTimings.wait("reaction channel fetch", () => this.client.channels.fetch(message.channel));
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return;
    const target = await requestTimings.wait("reaction message fetch", () => channel.messages.fetch(message.id));
    if (target.guildId !== message.server || target.author.id === this.client.user?.id) return;
    await requestTimings.wait("Discord reaction", () => target.react(emoji));
  }
  async reply(message: Message, text: string, deliveryId?: string, activity: readonly ToolActivity[] = [], ui?: UiDocument): Promise<readonly Message[]> {
    if (isPrivateChannel(message.channel)) return this.chatGateway.reply(message, text, deliveryId, activity, ui);
    requestTimings.begin(message, true);
    requestTimings.start(message, "delivery");
    let delivered = false;
    const outputs: Message[] = [];
    try {
    if (!this.bot.accepts(message.server, message.channel)) throw new ToolError("Channel was disabled before sending");
    const channel = await requestTimings.wait("Discord channel fetch", () => this.client.channels.fetch(message.channel));
    if (!channel?.isTextBased() || !channel.isSendable()) throw new ToolError("Channel cannot receive replies");
    let part = 0;
    // Freeze the footer in the existing delivery journal so retries keep identical content.
    const timingRecordId = deliveryId ?? `reply:${message.channel}:${message.id}`;
    const footer = await savedTimingFooter(this.store, message, timingRecordId);
    const rendered = await this.renderer.render(message.server, text + toolFooter(activity, toolDisplayMode(this.store.setting(message.server, "tool_display"))) + footer);
    const flags = suppressLinkPreviews(rendered) ? MessageFlags.SuppressEmbeds : undefined;
    const payloads: import('discord.js').MessageCreateOptions[] = splitReply(rendered).map(content=>({content,flags}));
    if(ui){const state=await this.uiRuntime.prepare(message,ui,deliveryId??message.id);payloads.push(discordUi(ui,state.id,state.revision));}
    for (const payload of payloads) {
      const content = payload.content ?? JSON.stringify(payload);
      const id = deliveryId ? stableOperationId(deliveryId, String(part++)) : undefined;
      const previous = id ? (await this.store.delivery(id)) : undefined;
      if (previous) {
        if (previous.content !== content || previous.message.channel !== message.channel) throw new UncertainActionError("Delivery ID conflicts with saved content");
        if (previous.result) { outputs.push(previous.result); continue; }
        let before: string | undefined, found: DiscordMessage | undefined;
        for (let page = 0; page < 20; page++) {
          const batch = await requestTimings.wait("Discord delivery reconciliation", () => channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }));
          found = batch.find(sent => sent.author.id === this.client.user?.id && String(sent.nonce) === id);
          if (found || !batch.size || batch.last()!.createdTimestamp < previous.createdAt - 5000) break;
          before = batch.last()!.id;
        }
        if (!found) throw new UncertainActionError("Reply delivery is uncertain. No duplicate was sent; inspect the task output before retrying.");
        const result = { ...this.normalize(found), addressed: false };
        (await this.store.finishDelivery(id!, result)); outputs.push(result); continue;
      }
      if (id) (await this.store.prepareDelivery(id, message, content));
      const sent = await requestTimings.wait<DiscordMessage>("Discord reply send", async () => channel.send({ ...payload, allowedMentions: { parse: [], repliedUser: false, ...(message.id.startsWith('command:reminder:') ? {users:[message.author]} : {}) },
        ...(id ? { nonce: id, enforceNonce: true } : {}),
        ...(!message.id.startsWith("task-seed:") && !message.id.startsWith("command:") ? { reply: { messageReference: message.id, failIfNotExists: false } } : {}) }));
      const result = { ...this.normalize(sent), addressed: false };
      if (id) (await this.store.finishDelivery(id, result));
      outputs.push(result);
    }
    await requestTimings.wait("Discord status cleanup", () => this.toolProgress.finish(JSON.stringify([message.server,message.channel,message.id])));
    // Web transcripts: the reply's runs are already saved, so their IDs are known now.
    const runIds = await this.store.requestRunIds(message.server, message.id);
    for (const output of outputs) await publishMessage(this.store, output, runIds, this.members).catch(error => logError("web_transcript_publish_failed", error, { server: this.guildId }, true));
    delivered = true;
    return outputs;
    } finally {
    requestTimings.end(message, "delivery");
    const timing = requestTimings.finish(message);
    if (timing) console.log(JSON.stringify({ type: "request_timing", server: message.server, channel: message.channel, messageId: message.id, delivery: delivered ? "sent" : "failed", ...timing }));
    if (timing) {
      try { await saveRequestTiming(this.store, message, timing, delivered ? "sent" : "failed", outputs, activity); }
      catch (error) { logError("request_timing_storage_failed", error, { stage: "timing storage", server: message.server, channel: message.channel, messageId: message.id }, true); }
    }
    }
  }
  async createTaskThread(message: Message, name: string): Promise<string> {
    if (isPrivateChannel(message.channel)) return this.chatGateway.createTaskThread();
    const channel = await this.client.channels.fetch(message.channel);
    if (channel?.type !== ChannelType.GuildText) throw new ToolError("Task parent must be a text channel");
    if (message.id.startsWith("command:")) {
      const thread = await channel.threads.create({ name: `${name} ${stableOperationId(message.id).slice(0, 8)}`, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
      return thread.id;
    }
    const source = await channel.messages.fetch(message.id);
    if (source.hasThread) {
      const thread = (source.thread ?? await channel.threads.fetch(source.id));
      if (!thread || thread.ownerId !== this.client.user?.id) throw new ToolError("This message already has a thread owned by someone else");
      return thread.id;
    }
    return (await source.startThread({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay })).id;
  }
  typing(channelId: string): () => void {
    if (isPrivateChannel(channelId)) return this.chatGateway.typing();
    const pulse = async () => { const channel = await this.client.channels.fetch(channelId); if (channel?.isTextBased() && "sendTyping" in channel) await channel.sendTyping(); };
    const send = () => { void pulse().catch(error => logError("discord_typing_failed", error, { channel: channelId }, true)); }; send();
    const timer = setInterval(send, 8000); timer.unref(); return () => clearInterval(timer);
  }
  async consoleSnapshot(user: string): Promise<unknown> {
    const guild = this.client.guilds.cache.get(this.guildId) ?? await this.client.guilds.fetch(this.guildId);
    // One member fetch and one bot fetch for the whole list. Each channel is then checked from the cache, with no REST call.
    const [member, bot, all] = await Promise.all([guild.members.fetch({ user, force: true }), guild.members.fetchMe(), guild.channels.fetch()]);
    const admin = member.permissions.has(PermissionFlagsBits.ManageGuild);
    const channels = [];
    const permission = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
    for (const channel of all.values()) {
      if (channel?.type !== ChannelType.GuildText) continue;
      if (!channel.permissionsFor(member)?.has(permission) || !channel.permissionsFor(bot)?.has(permission)) continue;
      channels.push({ id: channel.id, name: channel.name, monitored: this.channels.includes(channel.id), ...(admin ? { history: this.history.state(channel.id) } : {}) });
    }
    // The signed-in user's name and avatar for the account menu. The member directory gives the same avatar the chat shows.
    // The name is the user's own Discord name (global name, then username), never the server nickname.
    const known = (await this.members?.profiles(guild.id, [user]))?.get(user);
    return { server: { id: guild.id, name: guild.name }, user, admin, channels,
      me: { id: user, displayName: member.user.globalName ?? member.user.username, avatarUrl: known?.avatarUrl ?? null },
      profile: await this.store.profile(guild.id, user),
      mcp: admin ? this.mcp.snapshot() : null,
      settings: admin ? {
        monitoring: this.store.setting(guild.id, 'monitoring') ?? this.config.jevEnabled,
        classifier_context: this.store.setting(guild.id, 'classifier_context') ?? this.config.jevContextMessages,
        reply_context: this.store.setting(guild.id, 'reply_context') ?? this.config.replyContextMessages,
        cooldown_seconds: this.store.setting(guild.id, 'cooldown_seconds') ?? this.config.jevCooldownSeconds,
        max_unsolicited_per_hour: this.store.setting(guild.id, 'max_unsolicited_per_hour') ?? this.config.jevMaxRepliesPerHour,
        tool_display: toolDisplayMode(this.store.setting(guild.id, 'tool_display')),
        default_effort: parseEffort(this.store.setting(guild.id, 'default_effort')) ?? 'default',
        timing_footer: this.store.setting(guild.id, 'timing_footer') ?? false,
        mock: this.config.mock,
      } : null };
  }
  async consoleInvoke(user: string, channel: string, name: string, args: import('../tools.js').ToolArgs): Promise<unknown> {
    if (isPrivateChannel(channel)) throw new ToolError('Choose a text channel in this server.');
    const message: Message = { id: `command:web:${crypto.randomUUID()}`, server: this.guildId, channel, author: user, text: '' };
    await this.validateChannel(message, channel, true);
    if (name === 'profile') args = { ...args, user };
    return this.tools.invokeResult(message, name, args, message.id, 'command');
  }
  async consoleMcp(user: string, input: unknown): Promise<unknown> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const member = await guild.members.fetch({ user, force: true });
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new ToolError('Manage Server permission is required.');
    await this.mcp.configure(user, input);
    return { text: 'MCP configuration applied. Available tools update without a restart.', mcp: this.mcp.snapshot() };
  }
  private async assertManager(user: string): Promise<void> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const member = await guild.members.fetch({ user, force: true });
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new ToolError('Manage Server permission is required.');
  }
  /** Posts a web reply as the user. Only the user's own permissions and limits apply. */
  async consoleReply(user: string, channel: string, text: string): Promise<unknown> {
    if (isPrivateChannel(channel)) throw new ToolError('Private chats are not posted through Discord.');
    return this.webReplies.reply({ user, server: this.guildId, channel, text });
  }
  async consoleTranscripts(user: string): Promise<unknown> {
    await this.assertManager(user);
    return this.transcripts();
  }
  async consoleSetTranscript(user: string, channel: string, enabled: boolean): Promise<unknown> {
    await this.assertManager(user);
    return this.setTranscript(channel, enabled);
  }
  // Team admins skip the Manage Server check. The console checks their team role before it calls these.
  adminTranscripts(): Promise<{ channels: TranscriptChannel[] }> {
    return this.transcripts();
  }
  /** Channel count and how many channels have web transcripts on. Makes no Discord calls. */
  adminSummary(): { channelCount: number; transcriptsOn: number } {
    return { channelCount: this.channels.length, transcriptsOn: this.channels.filter(id => webTranscriptsEnabled(this.store, this.guildId, id)).length };
  }
  adminSetTranscript(channel: string, enabled: boolean): Promise<unknown> {
    return this.setTranscript(channel, enabled);
  }
  /** Makes a new web webhook for a monitored channel. Old webhook tokens stop working. */
  adminRotateWebhook(channel: string): Promise<{ webhookId: string }> {
    if (!this.channels.includes(channel)) throw new ToolError('Slopbot is not monitoring that channel.');
    return this.webReplies.rotateWebhook(this.guildId, channel);
  }
  private async transcripts(): Promise<{ channels: TranscriptChannel[] }> {
    const names = await (await this.client.guilds.fetch(this.guildId)).channels.fetch();
    return { channels: this.channels.map(id => ({ id, name: names.get(id)?.name ?? id, enabled: webTranscriptsEnabled(this.store, this.guildId, id) })) };
  }
  private async setTranscript(channel: string, enabled: boolean): Promise<unknown> {
    if (!this.channels.includes(channel)) throw new ToolError('Choose a channel that Slopbot serves in this server.');
    await this.store.setSetting(this.guildId, webTranscriptKey(channel), enabled);
    runEvents.changed(this.guildId);
    return { channel, enabled };
  }
  async start(): Promise<void> { await this.mcp.restore(); }
  async stop(): Promise<void> {
    if (this.historyTimer) clearInterval(this.historyTimer);
    await this.reminders.stop();
    await this.fixWatches?.stop();
    await this.history.stop(); await this.worker.stop(); await this.mcp.close();
  }
}

/** Owns the Discord client and runs one DiscordServer for each server that Slopbot is in. */
/** How long the console remembers which servers a user shares with Slopbot. */
const MEMBER_TTL_MS = 60_000;

export class DiscordAdapter {
  /** Users known to be members of a server, kept for MEMBER_TTL_MS. Only "yes" is kept, so a Discord error or a "no" is always checked again. */
  private readonly signInCache = new Map<string, number>();
  private readonly memberCache = new Map<string, { at: number; servers: { id: string; name: string; icon: string | null; admin: boolean }[] }>();
  private readonly client: Client;
  private readonly servers = new Map<string, Promise<DiscordServer>>();
  private readonly objectStorageProvider: S3StorageProvider | undefined;
  // One meter for the process. Its limiter is shared by every server, and discord-main attaches it to the embeddings.
  readonly usage: UsageMeter;
  private botUser: string | undefined;
  /** Live per-user view and send checks for the web console. */
  readonly access: ChannelAccess;
  /** Team roles of the Developer Portal team that owns the bot. Used by the console admin panel. */
  readonly team: TeamAdmins;
  /** Who may make, list and revoke share links: Manage Server in the server, or a team editor. */
  readonly shareRule: ShareRule;
  /** Share links for the web console. */
  readonly shares: ShareService;
  /** Discord names and avatars for the console and transcripts. One cache for every server. */
  readonly members: MemberDirectory;
  /** Custom status with today's reply count and the server count. Started when the client is ready. */
  private readonly presence: PresenceUpdater;

  constructor(private readonly config: Config, private readonly store: RuntimeStore, private readonly llm: LLM, client?: Client) {
    this.usage = createUsageMeter(config, store);
    this.client = client ?? new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Message, Partials.Channel] });
    this.members = new MemberDirectory(discordMemberSource(this.client));
    this.team = new TeamAdmins(discordTeamSource(this.client));
    this.access = new ChannelAccess(discordChannelAccessSource(this.client));
    wireChannelAccessEvents(this.client, this.access);
    this.presence = new PresenceUpdater({
      setStatus: text => { this.client.user?.setPresence({ activities: [{ type: ActivityType.Custom, name: 'custom', state: text }], status: 'online' }); },
      countReplies: since => this.store.countRepliesSince(since),
      guildCount: () => this.client.guilds.cache.size,
    });
    runEvents.attach(store);
    this.shareRule = { manager: (user, server) => this.hasManageServer(user, server), teamAdmin: user => this.team.canEdit(user) };
    this.objectStorageProvider = config.objectStorage ? new S3StorageProvider(config.objectStorage) : undefined;
    this.shares = new ShareService({ store, access: this.access, rule: this.shareRule, member: (user, server) => this.isServerMember(user, server), images: this.objectStorageProvider ?? new LocalDiskStorage() });
    this.client.once(Events.ClientReady, async client => {
      this.botUser = client.user.id;
      this.presence.start();
      console.log(`Slopbot connected as ${client.user.tag}. LLM mode: ${config.mock ? "mock" : "provider"}. Servers: ${client.guilds.cache.size}`);
      for (const guild of client.guilds.cache.values()) void this.open(guild.id).catch(error => logError("server_start_failed", error, { server: guild.id }));
    });
    // A server or member change drops the remembered membership at once.
    const forget = () => { this.memberCache.clear(); this.signInCache.clear(); };
    this.client.on(Events.GuildMemberRemove, forget); this.client.on(Events.GuildMemberUpdate, forget);
    this.client.on(Events.GuildCreate, guild => { forget(); if (this.botUser) void this.open(guild.id).catch(error => logError("server_start_failed", error, { server: guild.id })); });
    this.client.on(Events.GuildDelete, guild => { forget(); void this.close(guild.id).catch(error => logError("server_stop_failed", error, { server: guild.id })); });
    this.client.on(Events.InteractionCreate, interaction => { if (interaction.guildId) void this.route(interaction.guildId, server => server.interaction(interaction)); });
    this.client.on(Events.Error, error => logError("discord_client_failed", error));
    this.client.on(Events.MessageCreate, message => { if (message.guildId) void this.route(message.guildId, server => server.messageCreate(message)); });
    this.client.on(Events.MessageUpdate, (_old, updated) => { if (updated.guildId) void this.route(updated.guildId, server => server.messageUpdate(updated)); });
    this.client.on(Events.MessageDelete, message => { if (message.guildId) void this.route(message.guildId, server => server.messageDelete(message)); });
    this.client.on(Events.MessageBulkDelete, messages => { for (const message of messages.values()) if (message.guildId) void this.route(message.guildId, server => server.messageDelete(message)); });
  }
  /** True when the operator allows Slopbot in this server. An empty list allows all servers. */
  private allowed(guildId: string): boolean { return !this.config.guildIds.length || this.config.guildIds.includes(guildId); }
  private open(guildId: string): Promise<DiscordServer> {
    const existing = this.servers.get(guildId);
    if (existing) return existing;
    if (!this.allowed(guildId)) return Promise.reject(new ToolError("Slopbot is not enabled for this server."));
    const opening = (async () => {
      const server = new DiscordServer(this.config, this.store, this.llm, this.client, guildId, this.objectStorageProvider, this.usage, this.access, this.members, this.team);
      await server.start();
      await server.ready(this.botUser!);
      return server;
    })();
    this.servers.set(guildId, opening);
    opening.catch(() => { if (this.servers.get(guildId) === opening) this.servers.delete(guildId); });
    return opening;
  }
  private async close(guildId: string): Promise<void> {
    const server = this.servers.get(guildId);
    if (!server) return;
    this.servers.delete(guildId);
    await (await server).stop();
  }
  private async route(guildId: string, handle: (server: DiscordServer) => void): Promise<void> {
    const server = this.servers.get(guildId);
    if (!server) return;
    try { handle(await server); } catch (error) { logError("discord_event_failed", error, { server: guildId }); }
  }
  /** What the private chat service needs from Discord: membership, the server's handle, limits and access. */
  chatHost(): ChatHost {
    return {
      member: async (user, server) => this.servers.has(server) && (await this.consoleServers(user)).some(item => item.id === server),
      handle: async server => { const opening = this.servers.get(server); return opening ? await opening.catch(() => undefined) : undefined; },
      limiter: this.usage.limiter,
      access: this.access,
      members: this.members,
      ...(this.objectStorageProvider ? { images: this.objectStorageProvider } : {}),
    };
  }
  /**
   * True when Discord says the user is in the server, false when Discord says they are not. Any other error throws,
   * so a caller can answer "try again" instead of "not a member". Slopbot must have the server in its cache.
   */
  async isServerMember(user: string, server: string): Promise<boolean> {
    const guild = this.client.guilds.cache.get(server);
    if (!guild) throw new Error(`Server ${server} is not in the Discord cache.`);
    try {
      await guild.members.fetch({ user, force: true });
      return true;
    } catch (error) {
      // Discord error 10007 is Unknown Member, 10013 is Unknown User. discord.js puts the code on the error.
      const code = (error as { code?: unknown } | undefined)?.code;
      if (code === 10007 || code === 10013) return false;
      throw error;
    }
  }
  /** True when the user is in at least one server with Slopbot. Throws when Discord fails and no server matched. */
  async canSignIn(user: string): Promise<boolean> {
    const now = Date.now();
    const listed = this.memberCache.get(user);
    if (listed && listed.at > now - MEMBER_TTL_MS && listed.servers.length) return true;
    const seen = this.signInCache.get(user);
    if (seen !== undefined && seen > now - MEMBER_TTL_MS) return true;
    let failure: unknown;
    for (const id of this.servers.keys()) {
      try {
        if (await this.isServerMember(user, id)) {
          this.signInCache.set(user, Date.now());
          if (this.signInCache.size > 500) for (const [key, at] of this.signInCache) if (at < Date.now() - MEMBER_TTL_MS) this.signInCache.delete(key);
          return true;
        }
      } catch (error) { failure = error; }
    }
    if (failure) throw failure;
    return false;
  }
  /** Servers that both Slopbot and the user are in. */
  async consoleServers(user: string): Promise<{ id: string; name: string; icon: string | null; admin: boolean }[]> {
    const cached = this.memberCache.get(user);
    if (cached && cached.at > Date.now() - MEMBER_TTL_MS) return cached.servers;
    const found = (await Promise.all([...this.servers.keys()].map(async id => {
      const guild = this.client.guilds.cache.get(id);
      if (!guild) return undefined;
      const member = await guild.members.fetch({ user, force: true }).catch(() => undefined);
      return member ? { id, name: guild.name, icon: guild.iconURL({ size: 64 }), admin: member.permissions.has(PermissionFlagsBits.ManageGuild) } : undefined;
    }))).filter(item => item !== undefined);
    found.sort((a, b) => a.name.localeCompare(b.name));
    // A member who left is dropped within the TTL. Write checks (assertManager, consoleMcp) still fetch the member fresh.
    this.memberCache.set(user, { at: Date.now(), servers: found });
    if (this.memberCache.size > 500) for (const [key, value] of this.memberCache) if (value.at < Date.now() - MEMBER_TTL_MS) this.memberCache.delete(key);
    return found;
  }
  private async server(user: string, guildId: string | undefined): Promise<DiscordServer> {
    const servers = await this.consoleServers(user);
    const chosen = servers.find(item => item.id === guildId) ?? (guildId ? undefined : servers[0]);
    if (!chosen) throw new ToolError(guildId ? "You and Slopbot are not both in that server." : "You and Slopbot do not share a server yet.", "rejected");
    return this.servers.get(chosen.id)!;
  }
  async consoleSnapshot(user: string, guildId?: string): Promise<unknown> {
    const servers = await this.consoleServers(user);
    if (!servers.length) return { user, servers, server: null };
    const snapshot = await (await this.server(user, guildId)).consoleSnapshot(user) as Record<string, unknown>;
    return { ...snapshot, servers };
  }
  async consoleInvoke(user: string, guildId: string | undefined, channel: string, name: string, args: import('../tools.js').ToolArgs): Promise<unknown> {
    return (await this.server(user, guildId)).consoleInvoke(user, channel, name, args);
  }
  async consoleMcp(user: string, guildId: string | undefined, input: unknown): Promise<unknown> {
    return (await this.server(user, guildId)).consoleMcp(user, input);
  }
  async consoleTranscripts(user: string, guildId: string): Promise<unknown> {
    return (await this.server(user, guildId)).consoleTranscripts(user);
  }
  /** The signed-in user's own meter for one server. Only members of that server can read it. Percents only. */
  async consoleUsage(user: string, guildId: string): Promise<unknown> {
    await this.server(user, guildId);
    return usageView(await this.usage.limiter.usage(user));
  }
  /** Uses one of the user's own banked resets on a window. Members only. The limiter refuses when none is banked. */
  async consoleUseReset(user: string, guildId: string, kind: string): Promise<unknown> {
    await this.server(user, guildId);
    if (!await this.usage.limiter.useReset(user, kind)) throw new ToolError(`You have no banked ${kind === "5h" ? "5-hour" : "weekly"} reset.`);
    return usageView(await this.usage.limiter.usage(user));
  }
  /** The channel's name for the web transcript list. Undefined when the channel is not in the server. */
  async channelName(server: string, channel: string): Promise<string | undefined> {
    if (isPrivateChannel(channel)) return undefined;
    const found = await this.client.channels.fetch(channel).catch(() => undefined);
    if (!found || !("guildId" in found) || found.guildId !== server || !("name" in found) || typeof found.name !== "string") return undefined;
    return found.name;
  }
  async consoleReply(user: string, guildId: string | undefined, channel: string, text: string): Promise<unknown> {
    return (await this.server(user, guildId)).consoleReply(user, channel, text);
  }
  async consoleSetTranscript(user: string, guildId: string, channel: string, enabled: boolean): Promise<unknown> {
    return (await this.server(user, guildId)).consoleSetTranscript(user, channel, enabled);
  }
  /** The display name of a server, or its ID when Discord has not cached the name. */
  adminServerName(guildId: string): string {
    return this.client.guilds.cache.get(guildId)?.name ?? guildId;
  }
  /** The display name and icon of a server, as the Manage servers list shows them. */
  adminServerInfo(guildId: string): { name: string; icon: string | null } {
    const guild = this.client.guilds.cache.get(guildId);
    return { name: guild?.name ?? guildId, icon: guild?.iconURL({ size: 64 }) ?? null };
  }
  /** One page of the servers Slopbot runs in, filtered by name and sorted. Makes no channel calls. The console checks the team role first. */
  async adminServers(page: ServerPage): Promise<unknown> {
    const rows: ServerListRow[] = await Promise.all([...this.servers].map(async ([id, opening]) => ({ id, name: this.adminServerName(id), icon: this.client.guilds.cache.get(id)?.iconURL({ size: 64 }) ?? null, ...(await opening).adminSummary() })));
    return pageItems(rows, page);
  }
  /** One server's channels with their web transcript switches. */
  async adminServerChannels(guildId: string): Promise<unknown> {
    const opening = this.servers.get(guildId);
    if (!opening) throw new ToolError('Slopbot is not running in that server.');
    return { server: guildId, name: this.adminServerName(guildId), ...await (await opening).adminTranscripts() };
  }
  async adminSetTranscript(guildId: string, channel: string, enabled: boolean): Promise<unknown> {
    const opening = this.servers.get(guildId);
    if (!opening) throw new ToolError('Slopbot is not running in that server.');
    return (await opening).adminSetTranscript(channel, enabled);
  }
  async adminRotateWebhook(guildId: string, channel: string): Promise<unknown> {
    const opening = this.servers.get(guildId);
    if (!opening) throw new ToolError('Slopbot is not running in that server.');
    return (await opening).adminRotateWebhook(channel);
  }
  /** Manage Server in one guild. A user who is not a member, or has no permission, gets false. */
  async hasManageServer(user: string, server: string): Promise<boolean> {
    const guild = await this.client.guilds.fetch(server);
    const member = await guild.members.fetch({ user, force: true }).catch(() => undefined);
    return member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false;
  }
  async start(): Promise<void> { await this.client.login(this.config.discordToken); }
  async stop(): Promise<void> {
    this.presence.stop();
    await Promise.all([...this.servers.keys()].map(id => this.close(id)));
    await this.client.destroy();
    this.objectStorageProvider?.close();
  }
}
