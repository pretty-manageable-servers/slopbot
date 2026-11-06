import { LocalDiskStorage } from "../web-chat-images.js";
import { CLASSIFIER_CONTEXT_LIMIT } from '../classifier-input.js';
import { ChatFileFetcher } from "../web-chat-files.js";
import { sourceFingerprint } from "../source-context.js";
import { errorReply, logError } from "../errors.js";
import { sandboxManageTool, readSandboxFile } from "../sandbox.js";
import { sandboxFileTools } from "../sandbox-tools.js";
import { uploadRequestFiles } from "../sandbox-uploads.js";
import { sandboxPromptLine, type SandboxProfile } from "../sandbox-profile.js";
import { objectStorageTools, UserFileStorage, MAX_STORED_FILE_BYTES, fileStorageScope } from '../object-storage.js';
import { S3StorageProvider } from '../adapters/s3-storage.js';
import { runToolsCodeTool } from '../run-tools-code.js';
import { McpManager, McpSecrets } from '../mcp.js';
import { remoteMcpConnector } from '../adapters/mcp-client.js';
import { E2BSandboxProvider } from "../adapters/e2b-sandbox.js";
import { registerTimingTools } from "../timing-tools.js";
import { registerTaskTools } from '../productivity/tasks.js';
import { registerReminderTools, ReminderWorker } from '../productivity/reminders.js';
import { registerScheduleTool } from '../schedules/schedule-tool.js';
import { ScheduleWorker } from '../schedules/schedule-worker.js';
import { SCHEDULE_KIND } from '../schedules/schedule-types.js';
import { registerReportTools } from '../search/reports.js';
import { UiRuntime, registerUiTool, registerPollTool } from '../ui/runtime.js';
import { registerShowUiTool } from '../ui/show-ui.js';
import { registerShowWidgetTool } from '../ui/show-widget.js';
import type { UiDocument } from '../ui/schema.js';
import { CONFIRM_RECORD, saveConfirmation } from '../adapters/discord-code.js';
import { discordPresentation } from '../presentation/discord.js';
import { registerHistoryTools } from '../search/history-search.js';
import { registerViewImage } from '../view-image.js';
import { AttachQueue, registerAttachFile } from '../attach-file.js';
import { DiscordImageSource } from '../adapters/discord-image-source.js';
import { registerWebSearch } from "../web-search.js";
import { registerWebFetch } from "../web-fetch.js";
import { FallbackFetch, FallbackSearch, LimiterWebCharge, StoreKeyPool } from "../web-chain.js";
import { WebKeySecrets } from "../web-keys.js";
import { TavilySearch } from "../adapters/tavily.js";
import { FirecrawlScrape, FirecrawlSearch } from "../adapters/firecrawl.js";
import { PlainFetch } from "../adapters/plain-fetch.js";
import { SearxNGSearch } from "../adapters/searxng.js";
import { inspectFile } from '../files.js';
import { BOT_REPLY_LIMIT_KEY, botReplyLimit } from "../bot-reply-limit.js";
import { MUTED_USERS_KEY, mutedUsers } from "../muted-users.js";
import { GLOBAL_SETTINGS_SCOPE } from "../usage-cost.js";
import { registerProfileTools } from "../profiles.js";
import { publishTool } from "../run-events.js";
import { Application } from "../application.js";
import { Bot } from "../bot.js";
import type { Config } from "../config.js";
import { type Json, type Message } from "../domain.js";
import type { LLM } from "../ports.js";
import type { RuntimeStore } from "../runtime-store.js";
import { LLMClassifier, ParticipationGate } from "../participation.js";
import { HistoryImporter } from "../history.js";
import { DecisionClassifier } from "../adapters/decisions.js";
import { decisionThresholds } from '../participation-history.js';
import { TaskWorker } from "../queue.js";
import { UserLimiter } from "../user-limiter.js";
import { type UsageMeter } from "../usage-meter.js";
import { registerUsageTool } from "../usage-tools.js";
import { configuredChannels, registerServerTools } from "../server-tools.js";
import { Inbox } from "../inbox.js";
import { ChannelAccess } from "../channel-access.js";
import { TeamAdmins } from "../team-admins.js";
import { displayToolResult, ToolError, ToolRegistry } from "../tools.js";
import { isPrivateChannel, isDirectMessageChannel } from "../private-chat.js";
import { registerOperationsTools } from '../operations.js';
import { issueDraftTools } from '../issue-drafts.js';
import { HttpOperationsClient } from '../adapters/operations-client.js';
import { FixWatchWorker } from '../fix-watch-worker.js';
import type { Workspace } from "./api.js";
import type { WorkspacePorts, DegradedRouting } from "./ports.js";

/** The sandbox provider from the operator settings, or undefined when no sandbox key is set. */
export function sandboxProviderFor(config: Config): E2BSandboxProvider | undefined {
  return config.sandboxApiKey ? new E2BSandboxProvider({ apiKey: config.sandboxApiKey, apiUrl: config.sandboxApiUrl!, sandboxUrl: config.sandboxUrl!, ...(config.sandboxTemplate ? { template: config.sandboxTemplate } : {}) }) : undefined;
}

/** Slopbot state and services for one Discord server, without discord.js. The platform client reaches it through the Workspace interface and gives it WorkspacePorts. */
export class EngineWorkspace implements Workspace {
  readonly server: string;
  readonly bot: Bot;
  readonly app: Application;
  readonly reminders: ReminderWorker;
  readonly schedules: ScheduleWorker;
  readonly fixWatches: FixWatchWorker | undefined;
  readonly uiRuntime: UiRuntime;
  readonly tools: ToolRegistry;
  readonly mcp: McpManager;
  readonly worker: TaskWorker;
  readonly limiter: UserLimiter;
  readonly history: HistoryImporter;
  channels: string[];
  /** Files that attach_file queued, taken by the reply of each run. */
  readonly attachQueue = new AttachQueue();
  readonly inbox: Inbox;

  constructor(config: Config, private readonly store: RuntimeStore, llm: LLM, guildId: string, objectStorageProvider: S3StorageProvider | undefined, usage: UsageMeter, access: ChannelAccess, private readonly team: Pick<TeamAdmins, "canEdit"> | undefined, private readonly sandboxProfile: SandboxProfile | undefined, private readonly degraded: DegradedRouting | undefined, ports: WorkspacePorts) {
    this.server = guildId;
    this.inbox = new Inbox(store, access);
    this.channels = configuredChannels(config, store, guildId);
    this.history = new HistoryImporter(guildId, store, {
      fetch: async (channel, before, limit) => {
        if (!this.channels.includes(channel)) throw new ToolError("Channel is no longer configured");
        return (await ports.fetchHistory(channel, before, limit)).map(message => ({ ...message, addressed: false }));
      },
    }, config.historyWindowDays);
    const savedLimit = (key: string, fallback: number, max: number): number => {
      const value = store.setting(guildId, key);
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
    };
    const savedMonitoring = store.setting(guildId, "monitoring");
    const participation = new ParticipationGate(new DecisionClassifier({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.jevModel, usage }, store, undefined, new LLMClassifier(llm, store, usage)), {
      // JEV runs only when a model may answer now. Outages and the mode switch are read on each message.
      enabled: () => (typeof savedMonitoring === "boolean" ? savedMonitoring : config.jevEnabled) && !config.mock && (this.degraded === undefined || this.degraded.router.select(undefined) !== undefined),
      thresholds: decisionThresholds(store.setting(guildId, 'participation_thresholds'), config.jevThresholds),
      reactionFrequency: savedLimit("reaction_frequency", store.setting(guildId, "reactions_enabled") === false ? 0 : 60, 100),
      contextMessages: Math.min(CLASSIFIER_CONTEXT_LIMIT, savedLimit("classifier_context", config.jevContextMessages, 100)),
      cooldownMs: savedLimit("cooldown_seconds", config.jevCooldownSeconds, 3600) * 1000,
      maxUnsolicitedPerHour: savedLimit("max_unsolicited_per_hour", config.jevMaxRepliesPerHour, 1000),
    }, undefined, store);
    this.tools = new ToolRegistry(store, async message => {
      if (message.server !== guildId) return false;
      return ports.directory.canManage(message.author, guildId);
    }, async context => {
      // Edits, deletes and new messages never stop a tool. The run tells the model about them in its next round.
      if (context.source !== "agent") return;
      const message = context.message;
      if (!this.bot.accepts(message.server, message.channel)) throw new ToolError("This channel is no longer enabled for Slopbot");
      // An uncertain action blocks only its own resource (tools.ts), not the channel.
      if (this.tools.effect(context.toolName, context.arguments) === "write" && context.toolName !== "task_retry") {
        if (message.taskId && (await store.hasPendingOther(message.server, message.channel, message.id))) throw new ToolError("New contributions are queued; review them before further actions");
      }
    });
    this.mcp = new McpManager(guildId, store, this.tools, remoteMcpConnector({ allowPrivate: process.env.MCP_ALLOW_PRIVATE === 'true' }), new McpSecrets(process.env.MCP_SECRET_KEY), message => ports.validateChannel(message, message.channel));
    registerServerTools(this.tools, {
      config, server: guildId, store, participation, history: this.history, inbox: this.inbox,
      isTeamEditor: async user => team ? await team.canEdit(user).catch(() => false) : false,
      channels: () => this.channels,
      setChannels: channels => this.setChannels(channels),
      findChannels: (message, query) => ports.findChannels(message, query),
      validateChannel: (message, channel, parentOnly) => ports.validateChannel(message, channel, parentOnly),
      accepts: channel => this.bot.accepts(guildId, channel),
      setReplyContext: count => this.app.setRecentMessages(count),
      originMessage: async message => message.id.startsWith("task-seed:") ? (await store.canonicalMessage(message.server, message.id.slice(10))) ?? message : message,
      startTask: (message, goal) => this.bot.startTask(message, goal),
      reconcileTask: async message => {
        const registered = (await store.taskForSource(message.server, message.id));
        if (registered) { await this.bot.startTask(message, message.text); return registered; }
        const thread = await ports.taskThread(message);
        if (!thread) return undefined;
        (await store.registerTask(guildId, thread, message.channel, message.id));
        await this.bot.startTask(message, message.text);
        return thread;
      },
      wakeWorker: () => this.worker.wake(),
    });
    const authorizeFeature = async(message:Message,channel:string) => {
      if(!this.bot.accepts(message.server,channel))throw new ToolError('Channel is disabled.');
      await ports.validateChannel(message,channel);
    };
    this.uiRuntime = new UiRuntime(store,this.tools,authorizeFeature);
    registerTimingTools(this.tools, { store, authorize: authorizeFeature });
    if (config.operations) {
      const client = new HttpOperationsClient(config.operations);
      const operations = registerOperationsTools(this.tools, { store, config: config.operations, client, authorize: authorizeFeature }, guildId);
      // Member issue drafts file through the same GitHub client. They exist on every server where GitHub is configured, like github_issue_read; admin diagnostics stay in operations.servers.
      for (const tool of issueDraftTools({ store, client, authorize: authorizeFeature })) this.tools.register(tool);
      if (config.operations.servers.includes(guildId)) this.fixWatches = new FixWatchWorker(guildId, operations, async message => {
        await authorizeFeature(message, message.channel);
        await this.tools.checkAccess(message, 'fix_watch');
      }, async (message, text, id) => { await ports.reply(message, text, id); });
    }
    registerHistoryTools(this.tools,{store,authorize:authorizeFeature});
    // Images of stored messages, for view_image and model image input. Discord links are re-fetched; web chat images use storage.
    const imageSource = new DiscordImageSource({ attachments: async (channelId, messageId) => {
      return ports.imageAttachments(channelId, messageId);
    }, storage: objectStorageProvider ?? new LocalDiskStorage() });
    registerViewImage(this.tools,{store,images:imageSource,authorize:authorizeFeature});
    registerReportTools(this.tools,{store,llm,authorize:authorizeFeature,usage});
    registerPollTool(this.tools);
    registerTaskTools(this.tools,{store,authorize:authorizeFeature});
    registerReminderTools(this.tools,{store,authorize:authorizeFeature,reminderChannel:message=>ports.reminderChannel(message)});
    registerScheduleTool(this.tools,{store,authorize:authorizeFeature,isTeamEditor:async user=>team?await team.canEdit(user).catch(()=>false):false});
    this.reminders=new ReminderWorker(guildId,store,async(message,text,id)=>{await ports.reply(message,text,id);},authorizeFeature);
    this.schedules=new ScheduleWorker({
      server:guildId,store,authorize:authorizeFeature,
      // deliveryId is schedule:<id>:<slot or note>. The id is hex, so it has no colon. The owner is the mention target.
      reply:async(channel,text,deliveryId)=>{
        const record=await store.record(guildId,SCHEDULE_KIND,deliveryId.split(':')[1]??'');
        const owner=String((record?.value as Record<string,Json>|undefined)?.owner??'');
        await ports.reply({server:guildId,channel,author:owner,id:`command:${deliveryId}`,text:'',addressed:false,timestamp:Date.now()},text,deliveryId);
      },
      enqueuePrompt:async message=>{await this.worker.enqueue(message);},
      invokeTool:async(name,input,ctx)=>{
        const message:Message={server:guildId,channel:ctx.channel,author:ctx.author,id:ctx.id,text:`/slopbot ${name} ${JSON.stringify(input)}`,addressed:false,timestamp:Date.now()};
        return displayToolResult(await this.tools.invokeResult(message,name,input,ctx.id,ctx.source));
      },
      overGrace:who=>usage.overGrace(who),
      now:()=>new Date(),
      llmMode:()=>this.degraded?.mode()??"normal",
    });
    registerUiTool(this.tools);
    registerShowUiTool(this.tools);
    registerShowWidgetTool(this.tools);
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
      if (isPrivateChannel(known.channel) && !isDirectMessageChannel(known.channel)) throw new ToolError("Files in private chats are not available yet.");
      await ports.validateChannel(request, known.channel);
      const fresh = await ports.fetchMessage(known.channel, id);
      // A changed source is saved and used as it is now. The run does not stop for it.
      if (sourceFingerprint(fresh) !== sourceFingerprint(known)) await this.store.revise(fresh);
      return fresh;
    };
    const chatFiles = new ChatFileFetcher(objectStorageProvider ?? new LocalDiskStorage());
    const sandboxProvider = sandboxProviderFor(config);
    const storage = new UserFileStorage(store, objectStorageProvider);
    registerAttachFile(this.tools, { store, queue: this.attachQueue, storage, ...(objectStorageProvider ? { provider: objectStorageProvider } : {}), ...(sandboxProvider ? { sandbox: { provider: sandboxProvider, ...(this.sandboxProfile ? { profile: this.sandboxProfile } : {}) } } : {}), authorize: message => authorizeFeature(message, message.channel) });
    this.tools.register(sandboxManageTool(store, sandboxProvider));
    for (const tool of sandboxFileTools(store, sandboxProvider, this.sandboxProfile)) this.tools.register(tool);
    for (const tool of objectStorageTools({
      storage,
      fetcher: chatFiles,
      authorize: message => authorizeFeature(message, message.channel),
      resolveAttachment: (request, id) => resolveAttachment(request, id, true),
      inspect: (context, file, bytes, question) => inspectFile({ store, llm, usage, assertCurrent: async () => { const current = await storage.entry(context.message.server, context.message.author, file.owner, file.path, false, fileStorageScope(file), context.isAdmin); if (current.file.key !== file.key) throw new ToolError('Stored file changed during inspection. Read its current version.'); } }, context, file.path, file.contentType, bytes, question),
      send: async (context, file, bytes) => {
        const current = await storage.entry(context.message.server, context.message.author, file.owner, file.path, false, fileStorageScope(file), context.isAdmin);
        if (current.file.key !== file.key) throw new ToolError('Stored file changed before sending. Request its current version.');
        await ports.sendStoredFile(context, file, bytes);
      },
      // to_sandbox and save_sandbox need the sandbox. Without a provider, both report that it is not configured.
      ...(sandboxProvider ? { store, provider: sandboxProvider, ...(this.sandboxProfile ? { profile: this.sandboxProfile } : {}), sandbox: {
        read: (context, path) => readSandboxFile(store, sandboxProvider, context, path, MAX_STORED_FILE_BYTES, this.sandboxProfile?.home),
      } } : {}),
    })) this.tools.register(tool);
    this.limiter = usage.limiter;
    ports.registerTools(this.tools);
    registerUsageTool(this.tools, this.limiter);
    // Registered last: run_tools_code lists the tools registered before it in its description.
    this.tools.register(runToolsCodeTool(this.tools, { store, ...(this.sandboxProfile ? { profile: this.sandboxProfile } : {}), ...(sandboxProvider ? { sandbox: sandboxProvider } : {}), confirmations: {
      record: async (server, operationId) => (await store.record(server, CONFIRM_RECORD, operationId))?.value,
      save: (server, operationId, value) => saveConfirmation(store, server, operationId, value),
    } }));
    const sandboxPrompt = sandboxPromptLine(this.sandboxProfile);
    this.app = new Application(store, llm, {
      allowedChannels: this.channels.map(channel => ({ server: guildId, channel })),
      recentMessages: savedLimit("reply_context", config.replyContextMessages, 100),
      maxContextTokens: config.contextTokens, maxInputChars: config.contextTokens,
      maxOutputTokens: config.outputTokens, checkpointTokens: config.checkpointTokens, maxToolRounds: config.maxToolRounds,
    }, store, { usage, onToolActivity: async (message, activity) => { if (this.bot.accepts(message.server, message.channel)) publishTool(message, activity); }, presentation: discordPresentation, ...(sandboxPrompt ? { sandboxPrompt } : {}), profiles: store, harness: store, images: imageSource, tools: {
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
      const stop = ports.typing(message.channel);
      try {
        // A request copies its non-image files to the sandbox before the run. A failure does not stop the run.
        const uploads = message.uploadFiles && sandboxProvider ? await uploadRequestFiles({ store, provider: sandboxProvider, fetcher: chatFiles, ...(this.sandboxProfile ? { profile: this.sandboxProfile } : {}) }, message).catch(error => {
          logError("sandbox_upload_failed", error, { stage: "sandbox upload", server: message.server, channel: message.channel, messageId: message.id }, true);
          return undefined;
        }) : undefined;
        return await this.app.handle(uploads ? { ...message, uploads } : message, true);
      } finally { stop(); }
    }, (message, reply, id) => this.bot.deliver(message, reply, id), message => this.bot.accepts(message.server, message.channel), 3, async (job, error) => {
      if (!this.bot.accepts(job.message.server, job.message.channel)) return;
      await ports.reply(job.message, errorReply(error, job.id), `job-error:${job.id}`);
    });
    this.bot = new Bot(this.app, store, store, ports.gateway, guildId, this.channels, { profiles: store, knowledge: store, participation, worker: this.worker, tools: this.tools, queueStore: store, botReplyLimit: () => botReplyLimit(store.setting(GLOBAL_SETTINGS_SCOPE, BOT_REPLY_LIMIT_KEY)), mutedUntil: user => mutedUsers(store.setting(guildId, MUTED_USERS_KEY))[user], ...(this.degraded ? { router: this.degraded.router, degraded: { mode: this.degraded.mode, statusNoteMinutes: this.degraded.statusNoteMinutes } } : {}) });
  }
  /** Private chats: the chat service opens, closes and hands messages in through these. */
  openChat(channel: string): void { this.bot.openPrivateChat(this.server, channel); }
  closeChat(channel: string): void { this.bot.closePrivateChat(this.server, channel); }
  async submit(message: Message, options: { ingested?: boolean } = {}): Promise<void> {
    // The chat service saves the message first, so the bot must not save it again.
    await this.bot.receive({ ...message, botAuthor: false, mentionsBot: false, repliesToBot: false }, options);
  }
  /** True for Manage Server in this server or a Slopbot team editor. They stop and continue any response. */
  async stopAdmin(user: string, manager: boolean): Promise<boolean> {
    return manager || (this.team ? await this.team.canEdit(user).catch(() => false) : false);
  }
  /** Stops responses in a channel. Returns the stopped job IDs. */
  async stop(channel: string, user: string, manager: boolean): Promise<string[]> {
    return this.bot.stop(this.server, channel, user, await this.stopAdmin(user, manager));
  }
  /** Runs a card button in a private chat for its owner. The card uses this server's UI runtime and tools, as a command. */
  async act(channel: string, user: string, id: string, revision: number, index: number, interactionId: string): Promise<{ document: UiDocument; revision: number }> {
    const message: Message = { server: this.server, channel, author: user, id: `chat-ui:${interactionId}`, text: "UI action", timestamp: Date.now() };
    return this.uiRuntime.act(message, id, revision, index, interactionId);
  }
  async purgeAndIndex(): Promise<void> {
    const children = this.store.taskThreads(this.server).filter(task => this.channels.includes(task.parent)).map(task => task.thread);
    const scopes = [...this.channels, ...children];
    await this.store.purgeUnconfigured(this.server, scopes); await this.store.reindex(this.server, scopes);
  }
  async setChannels(channels: string[]): Promise<void> {
    const previous = this.channels;
    this.channels = [...channels]; this.bot.setChannels(channels);
    for (const channel of previous) if (!channels.includes(channel)) await this.history.exclude(channel);
    await this.purgeAndIndex();
    for (const channel of channels) if (!previous.includes(channel)) await this.history.include(channel);
  }
}
