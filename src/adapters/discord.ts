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
import { ToolError, ToolRegistry, UncertainActionError, stableOperationId } from "../tools.js";

export class DiscordAdapter implements ChatGateway {
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel],
  });
  private readonly bot: Bot;
  private readonly app: Application;
  private readonly renderer: ReplyRenderer;
  private readonly tools: ToolRegistry;
  private readonly worker: TaskWorker;
  private readonly history: HistoryImporter;
  private channels: string[];
  private historyTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: Config, private readonly store: RuntimeStore, llm: LLM) {
    this.renderer = new ReplyRenderer(store);
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
    registerProfileTools(this.tools, store);
    registerWebSearch(this.tools, config.searxngUrl ? new SearxNGSearch(config.searxngUrl) : new UnconfiguredSearch());
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
      maxOutputTokens: config.outputTokens, checkpointTokens: config.checkpointTokens,
    }, store, { profiles: store, harness: store, tools: { catalog: () => this.tools.catalog(), suggest: message => this.tools.suggest(message), execute: (message, call, id, version) => this.bot.executeTool(message, call, id, version) } });
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
      const reason = error instanceof UncertainActionError ? "An action or reply has an uncertain result. It will be reconciled before retrying." : "This request could not finish. You can ask me to retry it.";
      await this.reply(job.message, `${reason}\nJob ID: ${job.id}`, `job-error:${job.id}`);
    });
    this.bot = new Bot(this.app, store, store, this, config.guildId, this.channels, { profiles: store, knowledge: store, participation, worker: this.worker, tools: this.tools, queueStore: store });
    this.client.once(Events.ClientReady, client => {
      console.log(`Slopbot connected as ${client.user.tag}. LLM mode: ${config.mock ? "mock" : "provider"}`);
      void this.purgeAndIndex().catch(() => console.error("Database startup indexing failed"));
      void this.hydrateAuthors().catch(() => console.error("Author-name refresh unavailable; names will fill from new messages."));
      try { this.worker.start(); } catch (error) { console.error(error instanceof Error ? error.message : "Worker unavailable"); void this.client.destroy(); return; }
      const sync = () => { for (const channel of this.channels) void this.history.start(channel).catch(() => console.error("History import startup failed")); };
      sync(); this.historyTimer = setInterval(sync, 60000);
      void this.registerCommands().catch(() => console.error("Could not register /slopbot commands. Check application command permissions."));
    });
    this.client.on(Events.InteractionCreate, interaction => {
      if (interaction.isChatInputCommand() && interaction.commandName === "slopbot") void this.command(interaction).catch(() => console.error("Command failed."));
    });
    this.client.on(Events.Error, () => console.error("Discord client error. Check connection and bot configuration."));
    this.client.on(Events.MessageCreate, message => { void this.receive(message).catch(() => console.error("Discord event failed. Check channel permissions.")); });
    this.client.on(Events.MessageUpdate, (_old, updated) => {
      void (async () => {
        if (!updated.guildId || !this.bot.accepts(updated.guildId, updated.channelId)) return;
        const message = updated.partial ? await updated.fetch() : updated;
        await store.revise(this.normalize(message));
      })().catch(() => console.error("Could not update edited message context."));
    });
    this.client.on(Events.MessageDelete, message => {
      if (message.guildId && this.bot.accepts(message.guildId, message.channelId)) void store.remove(message.guildId, message.channelId, message.id);
    });
    this.client.on(Events.MessageBulkDelete, messages => {
      for (const message of messages.values()) if (message.guildId && this.bot.accepts(message.guildId, message.channelId)) void store.remove(message.guildId, message.channelId, message.id);
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
      const result = await this.tools.invoke(message, name, args, `command:${interaction.id}`, "command");
      const parts = splitReply(result);
      await interaction.editReply({ content: parts[0] ?? "Done.", allowedMentions: { parse: [] } });
      for (const content of parts.slice(1)) await interaction.followUp({ content, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}), allowedMentions: { parse: [] } });
    } catch (error) {
      await interaction.editReply(error instanceof ToolError || error instanceof UncertainActionError ? error.message : "Tool failed. Its recorded result will be reconciled before retrying.");
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
    const media = attachments.map(item => `[Attachment ${item.name}, type ${'contentType' in item ? item.contentType : 'unknown'}: ${item.url}; content not inspected]`).join("\n");
    return { attachments, id: message.id, server: message.guildId!, channel: message.channelId, author: message.author.id, authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username, authorAliases: [message.author.username, ...(message.author.globalName ? [message.author.globalName] : [])], isBot: message.author.bot, authorIdentity: { discord_handle: message.author.username, discord_name: message.author.globalName ?? message.author.username, server_nickname: message.member?.displayName ?? message.author.username, server_name: message.guild?.name ?? "" }, text: [text, media].filter(Boolean).join("\n"), timestamp: message.createdTimestamp,
      ...(message.reference?.messageId ? { replyTo: message.reference.messageId } : {}) };
  }
  private async receive(message: DiscordMessage): Promise<void> {
    if (!message.guildId || message.author.bot || !this.bot.accepts(message.guildId, message.channelId)) return;
    let repliesToBot = false;
    let referenced = message;
    const visited = new Set<string>();
    for (let depth = 0; depth < 4 && referenced.reference?.messageId; depth++) {
      if ((referenced.reference.channelId ?? message.channelId) !== message.channelId || visited.has(referenced.reference.messageId)) break;
      visited.add(referenced.reference.messageId);
      try {
        const reference = await referenced.fetchReference();
        if (reference.guildId !== message.guildId || reference.channelId !== message.channelId) break;
        if (depth === 0) repliesToBot = reference.author.id === this.client.user?.id;
        const source = { ...this.normalize(reference), addressed: false };
        await this.store.ingest(source);
        await this.store.revise(source);
        referenced = reference;
      } catch { break; } // Missing references grant no access.
    }
    const incoming: Incoming = { ...this.normalize(message), botAuthor: false, mentionsBot: this.client.user ? message.mentions.users.has(this.client.user.id) : false, repliesToBot };
    await this.bot.receive(incoming);
  }
  async reply(message: Message, text: string, deliveryId?: string): Promise<readonly Message[]> {
    if (!this.bot.accepts(message.server, message.channel)) throw new ToolError("Channel was disabled before sending");
    const channel = await this.client.channels.fetch(message.channel);
    if (!channel?.isTextBased() || !channel.isSendable()) throw new ToolError("Channel cannot receive replies");
    const outputs: Message[] = [];
    let part = 0;
    for (const content of splitReply(await this.renderer.render(message.server, text))) {
      const id = deliveryId ? stableOperationId(deliveryId, String(part++)) : undefined;
      const previous = id ? (await this.store.delivery(id)) : undefined;
      if (previous) {
        if (previous.content !== content || previous.message.channel !== message.channel) throw new UncertainActionError("Delivery ID conflicts with saved content");
        if (previous.result) { outputs.push(previous.result); continue; }
        let before: string | undefined, found: DiscordMessage | undefined;
        for (let page = 0; page < 20; page++) {
          const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
          found = batch.find(sent => sent.author.id === this.client.user?.id && String(sent.nonce) === id);
          if (found || !batch.size || batch.last()!.createdTimestamp < previous.createdAt - 5000) break;
          before = batch.last()!.id;
        }
        if (!found) throw new UncertainActionError("Reply delivery is uncertain. No duplicate was sent; inspect the task output before retrying.");
        const result = { ...this.normalize(found), addressed: false };
        (await this.store.finishDelivery(id!, result)); outputs.push(result); continue;
      }
      if (id) (await this.store.prepareDelivery(id, message, content));
      const sent = await channel.send({ content, allowedMentions: { parse: [], repliedUser: false },
        ...(id ? { nonce: id, enforceNonce: true } : {}),
        ...(!message.id.startsWith("task-seed:") && !message.id.startsWith("command:") ? { reply: { messageReference: message.id, failIfNotExists: false } } : {}) });
      const result = { ...this.normalize(sent), addressed: false };
      if (id) (await this.store.finishDelivery(id, result));
      outputs.push(result);
    }
    return outputs;
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
    const send = () => { void pulse().catch(() => undefined); }; send();
    const timer = setInterval(send, 8000); timer.unref(); return () => clearInterval(timer);
  }
  async start(): Promise<void> { await this.client.login(this.config.discordToken); }
  async stop(): Promise<void> {
    if (this.historyTimer) clearInterval(this.historyTimer);
    await this.history.stop(); await this.worker.stop(); await this.client.destroy();
  }
}
