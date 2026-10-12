import { errorReply, logError } from "../errors.js";
import { sandboxTool } from "../sandbox.js";
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
import { toolFooter } from '../presentation/tool-activity.js';
import type { ToolActivity } from '../tool-activity.js';
import { discordPresentation, suppressLinkPreviews } from '../presentation/discord.js';
import { registerHistoryTools } from '../search/history-search.js';
import { registerWebSearch, UnconfiguredSearch } from "../web-search.js";
import { SearxNGSearch } from "./searxng.js";
import { ReplyRenderer } from "../reply-renderer.js";
import { registerFileTool } from '../files.js';
import {
  Client, Events, GatewayIntentBits, Partials, ThreadAutoArchiveDuration,
  MessageFlags, PermissionFlagsBits, ChannelType,
  type ChatInputCommandInteraction, type Message as DiscordMessage,
} from "discord.js";
import { buildToolCommands } from "./discord-commands.js";
import { registerProfileTools } from "../profiles.js";
import { Application } from "../application.js";
import { Bot, splitReply, type ChatGateway, type Incoming } from "../bot.js";
import type { Config } from "../config.js";
import type { Message } from "../domain.js";
import type { LLM } from "../ports.js";
import type { RuntimeStore } from "../runtime-store.js";
import { LLMClassifier, ParticipationGate } from "../participation.js";
import { HistoryImporter } from "../history.js";
import { DecisionClassifier } from "./decisions.js";
import { TaskWorker } from "../queue.js";
import { configuredChannels, registerServerTools } from "../server-tools.js";
import { displayToolResult, ToolError, ToolRegistry, UncertainActionError, stableOperationId } from "../tools.js";

export class DiscordAdapter implements ChatGateway {
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel],
  });
  private readonly bot: Bot;
  private readonly app: Application;
  private readonly renderer: ReplyRenderer;
  private readonly reminders: ReminderWorker;
  private readonly uiRuntime: UiRuntime;
  private readonly toolProgress = new DiscordToolProgress();
  private readonly tools: ToolRegistry;
  private readonly mcp: McpManager;
  private readonly worker: TaskWorker;
  private readonly history: HistoryImporter;
  private channels: string[];
  private historyTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: Config, private readonly store: RuntimeStore, llm: LLM) {
    this.renderer = new ReplyRenderer(store, discordPresentation);
    this.channels = configuredChannels(config, store);
    this.history = new HistoryImporter(config.guildId, store, {
      fetch: async (channel, before, limit) => {
        if (!this.channels.includes(channel)) throw new ToolError("Channel is no longer configured");
        const target = await this.client.channels.fetch(channel);
        if (!target || target.type !== ChannelType.GuildText || target.guildId !== config.guildId) throw new ToolError("Text channel unavailable");
        const batch = await target.messages.fetch({ limit, ...(before ? { before } : {}) });
        return [...batch.values()].sort((a, b) => a.id === b.id ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1)
          .map(message => ({ ...this.normalize(message), addressed: false }));
      },
    }, config.historyWindowDays);
    const savedLimit = (key: string, fallback: number, max: number): number => {
      const value = store.setting(config.guildId, key);
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
    };
    const savedMonitoring = store.setting(config.guildId, "monitoring");
    const participation = new ParticipationGate(new DecisionClassifier({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.jevModel }, store, undefined, new LLMClassifier(llm, store)), {
      enabled: (typeof savedMonitoring === "boolean" ? savedMonitoring : config.jevEnabled) && !config.mock,
      reactionFrequency: savedLimit("reaction_frequency", store.setting(config.guildId, "reactions_enabled") === false ? 0 : 60, 100),
      contextMessages: savedLimit("classifier_context", config.jevContextMessages, 100),
      cooldownMs: savedLimit("cooldown_seconds", config.jevCooldownSeconds, 3600) * 1000,
      maxUnsolicitedPerHour: savedLimit("max_unsolicited_per_hour", config.jevMaxRepliesPerHour, 1000),
    });
    this.tools = new ToolRegistry(store, async message => {
      if (message.server !== config.guildId) return false;
      const guild = await this.client.guilds.fetch(config.guildId);
      const member = await guild.members.fetch({ user: message.author, force: true });
      return member.permissions.has(PermissionFlagsBits.ManageGuild);
    }, async (context, expectedVersion) => {
      if (context.source !== "agent") return;
      const message = context.message, source = (await store.canonicalMessage(message.server, message.id));
      if (!source || source.text !== message.text || !this.bot.accepts(message.server, message.channel)) throw new ToolError("Source or channel changed before the action");
      if (expectedVersion !== undefined && expectedVersion !== await store.contextVersion(message.server, message.channel)) throw new ToolError("Context changed before the action");
      if (this.tools.effect(context.toolName, context.arguments) === "write" && context.toolName !== "task_retry") {
        if ((await store.hasBlocked(message.server, message.channel))) throw new ToolError("This task has an uncertain action; reconcile it before new writes");
        if (message.taskId && (await store.hasPendingOther(message.server, message.channel, message.id))) throw new ToolError("New contributions are queued; review them before further actions");
      }
    });
    this.mcp = new McpManager(config.guildId, store, this.tools, remoteMcpConnector({ allowPrivate: process.env.MCP_ALLOW_PRIVATE === 'true' }), new McpSecrets(process.env.MCP_SECRET_KEY), message => this.validateChannel(message, message.channel));
    registerServerTools(this.tools, {
      config, store, participation, history: this.history,
      channels: () => this.channels,
      setChannels: channels => this.setChannels(channels),
      findChannels: async (message, query) => {
        const guild = await this.client.guilds.fetch(config.guildId);
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
      accepts: channel => this.bot.accepts(config.guildId, channel),
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
        (await store.registerTask(config.guildId, thread.id, message.channel, message.id));
        await this.bot.startTask(message, message.text);
        return thread.id;
      },
      wakeWorker: () => this.worker.wake(),
    });
    this.tools.register(sandboxTool(store, config.sandboxApiKey ? new E2BSandboxProvider({ apiKey: config.sandboxApiKey, apiUrl: config.sandboxApiUrl!, sandboxUrl: config.sandboxUrl!, ...(config.sandboxTemplate ? { template: config.sandboxTemplate } : {}) }) : undefined));
    const authorizeFeature = async(message:Message,channel:string) => {
      if(!this.bot.accepts(message.server,channel))throw new ToolError('Channel is disabled.');
      await this.validateChannel(message,channel);
    };
    this.uiRuntime = new UiRuntime(store,this.tools,authorizeFeature);
    registerTimingTools(this.tools, { store, authorize: authorizeFeature });
    registerHistoryTools(this.tools,{store,authorize:authorizeFeature});
    registerReportTools(this.tools,{store,llm,authorize:authorizeFeature});
    registerPollTool(this.tools);
    registerTaskTools(this.tools,{store,authorize:authorizeFeature});
    registerReminderTools(this.tools,{store,authorize:authorizeFeature});
    this.reminders=new ReminderWorker(config.guildId,store,async(message,text,id)=>{await this.reply(message,text,id);},authorizeFeature);
    registerUiTool(this.tools);
    registerProfileTools(this.tools, store);
    registerWebSearch(this.tools, config.searxngUrl ? new SearxNGSearch(config.searxngUrl, fetch, Date.now, config.searxngAccess) : new UnconfiguredSearch());
    registerFileTool(this.tools, { store, llm, resolve: async (request, requestedId) => {
      const id = requestedId ?? (request.attachments?.length ? request.id : request.replyTo);
      if (!id) throw new ToolError("Reply to a message with a file attached.");
      const known = (await store.canonicalMessage(request.server, id));
      if (!known || known.channel !== request.channel || !this.bot.accepts(request.server, known.channel)) throw new ToolError("File source must be in this permitted channel.");
      await this.validateChannel(request, known.channel);
      const channel = await this.client.channels.fetch(known.channel);
      if (!channel || !channel.isTextBased() || !("messages" in channel)) throw new ToolError("Source channel unavailable");
      const fresh = this.normalize(await channel.messages.fetch(id));
      if (fresh.text !== known.text && JSON.stringify(fresh.attachments?.map(({url,...item}) => item)) !== JSON.stringify(known.attachments?.map(({url,...item}) => item))) throw new ToolError("Attachment metadata changed. Submit a new request.");
      return fresh;
    } });
    this.app = new Application(store, llm, {
      allowedChannels: this.channels.map(channel => ({ server: config.guildId, channel })),
      recentMessages: savedLimit("reply_context", config.replyContextMessages, 100),
      maxContextTokens: config.contextTokens, maxInputChars: config.contextTokens,
      maxOutputTokens: config.outputTokens, checkpointTokens: config.checkpointTokens, maxToolRounds: config.maxToolRounds,
    }, store, { onToolActivity: async (message, activity) => {
      if (!this.bot.accepts(message.server, message.channel)) return;
      await this.toolProgress.update(JSON.stringify([message.server,message.channel,message.id]), activity, async content => {
        const channel = await this.client.channels.fetch(message.channel);
        if (!channel?.isTextBased() || !channel.isSendable()) throw new ToolError("Status channel unavailable");
        return channel.send({content,reply:{messageReference:message.id,failIfNotExists:false},allowedMentions:{parse:[],repliedUser:false}});
      });
    }, presentation: discordPresentation, profiles: store, harness: store, tools: {
      catalog: () => this.tools.catalog(), schemas: () => this.tools.schemas(), suggest: message => this.tools.suggest(message),
      execute: (message, call, id, version) => this.bot.executeTool(message, call, id, version),
      snapshot: () => {
        const selected = this.tools.capture();
        return { catalog: selected.catalog, schemas: selected.schemas, suggest: selected.suggest, execute: (message, call, id, version) => {
          selected.assertCurrent(call.name);
          return this.bot.executeTool(message, call, id, version);
        } };
      },
    } });
    this.worker = new TaskWorker(config.guildId, store, async message => {
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
    this.bot = new Bot(this.app, store, store, this, config.guildId, this.channels, { profiles: store, knowledge: store, participation, worker: this.worker, tools: this.tools, queueStore: store });
    this.client.once(Events.ClientReady, client => {
      console.log(`Slopbot connected as ${client.user.tag}. LLM mode: ${config.mock ? "mock" : "provider"}`);
      if (!this.channels.length) console.warn("No channels configured. Use /slopbot channels action:add channel:<test channel> to enable replies.");
      void this.purgeAndIndex().catch(error => logError("Database startup indexing failed", error));
      void this.hydrateAuthors().catch(error => logError("Author-name refresh unavailable; names will fill from new messages.", error));
      try { this.worker.start(); } catch (error) { console.error(error instanceof Error ? error.message : "Worker unavailable"); void this.client.destroy(); return; }
      const sync = () => { for (const channel of this.channels) void this.history.start(channel).catch(error => logError("History import startup failed", error)); };
      this.reminders.start();
      sync(); this.historyTimer = setInterval(sync, 60000);
      void this.registerCommands().catch(error => logError("Could not register /slopbot commands. Check application command permissions.", error));
    });
    this.client.on(Events.InteractionCreate, interaction => {
      if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('slopui:')) {
        void handleDiscordUi(interaction,this.uiRuntime).catch(error => logError('UI interaction display failed.', error));
      }
      if (interaction.isChatInputCommand() && interaction.commandName === "slopbot") void this.command(interaction).catch(error => logError("Command failed.", error));
    });
    this.client.on(Events.Error, error => logError("discord_client_failed", error));
    this.client.on(Events.MessageCreate, message => { void this.receive(message).catch(error => logError("Discord event failed. Check channel permissions.", error)); });
    this.client.on(Events.MessageUpdate, (_old, updated) => {
      void (async () => {
        if (!updated.guildId || !this.bot.accepts(updated.guildId, updated.channelId)) return;
        const message = updated.partial ? await updated.fetch() : updated;
        await store.revise(this.normalize(message));
      })().catch(error => logError("Could not update edited message context.", error));
    });
    this.client.on(Events.MessageDelete, message => {
      if (message.guildId && this.bot.accepts(message.guildId, message.channelId)) void store.remove(message.guildId, message.channelId, message.id).catch(error => logError("discord_message_delete_failed", error, { messageId: message.id }));
    });
    this.client.on(Events.MessageBulkDelete, messages => {
      for (const message of messages.values()) if (message.guildId && this.bot.accepts(message.guildId, message.channelId)) void store.remove(message.guildId, message.channelId, message.id).catch(error => logError("discord_message_delete_failed", error, { messageId: message.id }));
    });
  }
  private async purgeAndIndex(): Promise<void> {
    const children = this.store.taskThreads(this.config.guildId).filter(task => this.channels.includes(task.parent)).map(task => task.thread);
    const scopes = [...this.channels, ...children];
    await this.store.purgeUnconfigured(this.config.guildId, scopes); await this.store.reindex(this.config.guildId, scopes);
  }
  private async setChannels(channels: string[]): Promise<void> {
    const previous = this.channels;
    this.channels = [...channels]; this.bot.setChannels(channels);
    for (const channel of previous) if (!channels.includes(channel)) await this.history.exclude(channel);
    await this.purgeAndIndex();
    for (const channel of channels) if (!previous.includes(channel)) await this.history.include(channel);
  }
  private async validateChannel(message: Message, channelId: string, parentOnly = false): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(channel.type === ChannelType.GuildText || (!parentOnly && channel.isThread())) || channel.guildId !== message.server || message.server !== this.config.guildId) throw new ToolError("Choose a text channel in this server.");
    const guild = await this.client.guilds.fetch(message.server);
    const member = await guild.members.fetch({ user: message.author, force: true });
    const bot = await guild.members.fetchMe();
    const permission = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
    if (!channel.permissionsFor(member)?.has(permission) || !channel.permissionsFor(bot)?.has(permission)) throw new ToolError("Both you and Slopbot need View Channel and Read Message History permission.");
  }
  private async registerCommands(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    const command = buildToolCommands(this.tools);
    await guild.commands.create(command.toJSON());
  }
  private async command(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.guildId !== this.config.guildId) return;
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
      logError("command_failed", error, { stage: "slash command", server: this.config.guildId, messageId: interaction.id });
      await interaction.editReply({content: errorReply(error), allowedMentions: {parse: []}});
    }
  }
  private async hydrateAuthors(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    const authors = (await this.store.knownAuthors(this.config.guildId)).filter(item => /^\d{17,20}$/.test(item.author));
    let refreshed = 0;
    for (let offset = 0; offset < authors.length; offset += 4) {
      const results = await Promise.allSettled(authors.slice(offset, offset + 4).map(async ({ author }) => {
        const member = await guild.members.fetch(author).catch(() => undefined);
        const user = member?.user ?? await this.client.users.fetch(author);
        await this.store.identifyAuthor(this.config.guildId, author, [member?.displayName ?? user.globalName ?? user.username, user.username, ...(user.globalName ? [user.globalName] : [])], user.bot, { discord_handle: user.username, discord_name: user.globalName ?? user.username, server_nickname: member?.displayName ?? user.username, server_name: guild.name });
      }));
      refreshed += results.filter(result => result.status === "fulfilled").length;
    }
    console.log(`Author names refreshed: ${refreshed}/${authors.length}; unresolved names can be supplied with Discord mentions.`);
  }
  private normalize(message: DiscordMessage): Message {
    const id = this.client.user?.id;
    const text = id ? message.content.replace(new RegExp(`<@!?${id}>`, "g"), "").trim() : message.content;
    const attachments = [...message.attachments.values()].map(item => ({ name: item.name ?? "file", url: item.url, size: item.size, ...(item.contentType ? { contentType: item.contentType } : {}) }));
    for (const embed of message.embeds) {
      const media = embed.image ?? embed.thumbnail;
      const url = media?.url ?? media?.proxyURL;
      if (url && /\.(gif|png|jpe?g|webp)(?:\?|$)/i.test(url) && !attachments.some(item => item.url === url)) attachments.push({ name: new URL(url).pathname.split('/').pop() ?? 'image.gif', url, size: 0 });
    }
    const embedText = message.author.bot || message.webhookId
      ? message.embeds.map(embed => [embed.title, embed.description, ...embed.fields.map(field => `${field.name}: ${field.value}`)].filter(Boolean).join("\n")).filter(Boolean).join("\n").slice(0, 12000)
      : "";
    const media = attachments.map(item => `[Attachment ${item.name}, type ${'contentType' in item ? item.contentType : 'unknown'}: ${item.url}; content not inspected]`).join("\n");
    return { attachments, id: message.id, server: message.guildId!, channel: message.channelId, author: message.author.id, authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username, authorAliases: [message.author.username, ...(message.author.globalName ? [message.author.globalName] : [])], isBot: message.author.bot || Boolean(message.webhookId), authorIdentity: { discord_handle: message.author.username, discord_name: message.author.globalName ?? message.author.username, server_nickname: message.member?.displayName ?? message.author.username, server_name: message.guild?.name ?? "" }, text: [text, embedText, media].filter(Boolean).join("\n"), timestamp: message.createdTimestamp,
      ...(message.reference?.messageId ? { replyTo: message.reference.messageId } : {}) };
  }
  private async receive(message: DiscordMessage): Promise<void> {
    if (!message.guildId || message.author.id === this.client.user?.id || !this.bot.accepts(message.guildId, message.channelId)) return;
    const timingScope = { server: message.guildId, channel: message.channelId, id: message.id };
    requestTimings.begin(timingScope); requestTimings.start(timingScope, "references");
    await requestTimings.withScope(timingScope, () => this.receiveScoped(message, timingScope));
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
    const incoming: Incoming = { ...this.normalize(message), botAuthor: message.author.bot || Boolean(message.webhookId), mentionsBot: this.client.user ? message.mentions.users.has(this.client.user.id) : false, repliesToBot };
    requestTimings.end(timingScope, "references");
    await this.bot.receive(incoming);
  }
  async react(message: Message, emoji: string): Promise<void> {
    if (!this.bot.accepts(message.server, message.channel)) return;
    const channel = await requestTimings.wait("reaction channel fetch", () => this.client.channels.fetch(message.channel));
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return;
    const target = await requestTimings.wait("reaction message fetch", () => channel.messages.fetch(message.id));
    if (target.guildId !== message.server || target.author.id === this.client.user?.id) return;
    await requestTimings.wait("Discord reaction", () => target.react(emoji));
  }
  async reply(message: Message, text: string, deliveryId?: string, activity: readonly ToolActivity[] = [], ui?: UiDocument): Promise<readonly Message[]> {
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
    const rendered = await this.renderer.render(message.server, text + toolFooter(activity) + footer);
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
    if (activity.length) await requestTimings.wait("Discord status cleanup", () => this.toolProgress.finish(JSON.stringify([message.server,message.channel,message.id])));
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
    const pulse = async () => { const channel = await this.client.channels.fetch(channelId); if (channel?.isTextBased() && "sendTyping" in channel) await channel.sendTyping(); };
    const send = () => { void pulse().catch(error => logError("discord_typing_failed", error, { channel: channelId }, true)); }; send();
    const timer = setInterval(send, 8000); timer.unref(); return () => clearInterval(timer);
  }
  async consoleSnapshot(user: string): Promise<unknown> {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    const member = await guild.members.fetch({ user, force: true });
    const admin = member.permissions.has(PermissionFlagsBits.ManageGuild);
    const channels = [];
    for (const channel of (await guild.channels.fetch()).values()) {
      if (channel?.type !== ChannelType.GuildText) continue;
      try {
        await this.validateChannel({ server: guild.id, channel: channel.id, author: user, id: 'command:web', text: '' }, channel.id, true);
        channels.push({ id: channel.id, name: channel.name, monitored: this.channels.includes(channel.id), ...(admin ? { history: this.history.state(channel.id) } : {}) });
      } catch (error) { if (!(error instanceof ToolError)) throw error; }
    }
    return { server: { id: guild.id, name: guild.name }, user, admin, channels,
      profile: await this.store.profile(guild.id, user),
      mcp: admin ? this.mcp.snapshot() : null,
      settings: admin ? {
        monitoring: this.store.setting(guild.id, 'monitoring') ?? this.config.jevEnabled,
        classifier_context: this.store.setting(guild.id, 'classifier_context') ?? this.config.jevContextMessages,
        reply_context: this.store.setting(guild.id, 'reply_context') ?? this.config.replyContextMessages,
        cooldown_seconds: this.store.setting(guild.id, 'cooldown_seconds') ?? this.config.jevCooldownSeconds,
        max_unsolicited_per_hour: this.store.setting(guild.id, 'max_unsolicited_per_hour') ?? this.config.jevMaxRepliesPerHour,
        timing_footer: this.store.setting(guild.id, 'timing_footer') ?? false,
        model: this.config.model, mock: this.config.mock,
      } : null };
  }
  async consoleInvoke(user: string, channel: string, name: string, args: import('../tools.js').ToolArgs): Promise<unknown> {
    const message: Message = { id: `command:web:${crypto.randomUUID()}`, server: this.config.guildId, channel, author: user, text: '' };
    await this.validateChannel(message, channel, true);
    if (name === 'profile') args = { ...args, user };
    return this.tools.invokeResult(message, name, args, message.id, 'command');
  }
  async consoleMcp(user: string, input: unknown): Promise<unknown> {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    const member = await guild.members.fetch({ user, force: true });
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new ToolError('Manage Server permission is required.');
    await this.mcp.configure(user, input);
    return { text: 'MCP configuration applied. Available tools update without a restart.', mcp: this.mcp.snapshot() };
  }
  async start(): Promise<void> { await this.mcp.restore(); await this.client.login(this.config.discordToken); }
  async stop(): Promise<void> {
    if (this.historyTimer) clearInterval(this.historyTimer);
    await this.reminders.stop();
    await this.history.stop(); await this.worker.stop(); await this.mcp.close(); await this.client.destroy();
  }
}
