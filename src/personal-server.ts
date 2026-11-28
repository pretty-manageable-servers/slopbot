import type { ChatGateway } from "./bot.js";
import { WebChatGateway } from "./engine/web-chat-gateway.js";
import { EngineWorkspace } from "./engine/workspace.js";
import { startAttachLinkSweep, type AttachQueue } from "./attach-file.js";
import { startCodeMaintenance } from "./code-maintenance.js";
import { randomUUID } from "node:crypto";
import { ToolError, logError } from "./errors.js";
import { isDirectMessageChannel, isPrivateChannel } from "./private-chat.js";
import { PERSONAL_SERVER } from "./personal.js";
import { LocalDiskStorage } from "./web-chat-images.js";
import type { Config } from "./config.js";
import type { LLM } from "./ports.js";
import type { RuntimeStore } from "./runtime-store.js";
import type { UsageMeter } from "./usage-meter.js";
import type { ChannelAccess } from "./channel-access.js";
import type { TeamAdmins } from "./team-admins.js";
import type { Directory } from "./engine/api.js";
import type { DegradedRouting, WorkspacePorts } from "./engine/ports.js";
import type { S3StorageProvider } from "./adapters/s3-storage.js";
import { PostgresStore } from "./adapters/postgres.js";
import { SQLiteStore } from "./adapters/sqlite.js";
import type { AssistantBackend } from "./clients/web/routes/assistant.js";
import { AssistantWorker } from "./assistant/worker.js";
import { Gate } from "./assistant/gate.js";
import { ensureHomeChat, registerAssistantTools } from "./assistant/tools.js";
import { listConnectors, putConnector, removeConnector } from "./assistant/connectors.js";
import { readAssistantLimits } from "./assistant/limits.js";
import { noopNotifier } from "./assistant/noop-notifier.js";
import { sqliteAssistantStore } from "./assistant/sqlite-store.js";
import { pgAssistantStore } from "./assistant/pg-store.js";
import { assistantHomeChannel, type AssistantLimits, type Notifier } from "./assistant/types.js";
import type { AssistantSqlStore } from "./assistant/sqlite-store.js";
import { privateChatTitle, PRIVATE_CHANNEL_PREFIX } from "./private-chat.js";

/** Discord DM delivery for the personal workspace. The Discord client gives it (WP2); absent in local mode. */
export interface PersonalDmPorts extends Pick<WorkspacePorts, "reply" | "typing" | "fetchHistory" | "fetchMessage" | "imageAttachments" | "sendStoredFile"> { readonly gateway: ChatGateway }
export interface PersonalServerDeps { config: Config; store: RuntimeStore; llm: LLM; usage: UsageMeter; access: ChannelAccess;
  team: Pick<TeamAdmins, "canEdit">; directory: Directory; images?: S3StorageProvider; degraded?: DegradedRouting; dm?: PersonalDmPorts;
  /** INCOGNITO_SERVER for private chats. Default PERSONAL_SERVER. */ server?: string;
  /** Where Bud sends activity updates (Discord DMs). Default: nowhere. */ notifier?: Notifier }

/** Bud's backend for the console, plus the Gate (the Discord buttons call it). */
export interface AssistantHandle { backend: AssistantBackend; gate: Gate; store: AssistantSqlStore; limits(): Promise<AssistantLimits> }

/** The assistant tables live in the SQLite and Postgres stores. Other stores have no assistant. */
const assistantStoreOf = (store: PostgresStore | SQLiteStore): AssistantSqlStore => store instanceof PostgresStore ? pgAssistantStore(store) : sqliteAssistantStore(store);

const DM_UNAVAILABLE = "DMs are not available here.";

/**
 * The personal workspace: hosts every web chat (and, with deps.dm, Discord DMs). It is not a Discord server.
 * Web chat replies go to its own WebChatGateway; `web:dm:` channels go to deps.dm.
 */
export class PersonalServer {
  readonly workspace: EngineWorkspace;
  /** What the workspace calls back into; public so tests can exercise the port rules directly. */
  readonly ports: WorkspacePorts;
  private readonly server: string;
  private web: WebChatGateway | undefined;
  private codeMaintenance: (() => void) | undefined;
  private attachSweep: (() => void) | undefined;
  /** Bud: the assistant's store, gate and web backend. Undefined for a store that has no assistant tables. */
  readonly assistant: AssistantHandle | undefined;
  private readonly assistantWorker: AssistantWorker | undefined;

  constructor(private readonly deps: PersonalServerDeps) {
    const server = this.server = deps.server ?? PERSONAL_SERVER;
    const { dm } = deps;
    // The workspace reads ports.gateway while it is built, before this.workspace exists, so the queue is reached late.
    const lateQueue = { take: (run: string) => this.workspace.attachQueue.take(run) } as AttachQueue;
    const web = () => this.web ??= new WebChatGateway(deps.store, server, { queue: lateQueue, storage: deps.images ?? new LocalDiskStorage() });
    const needDm = (): PersonalDmPorts => { if (!dm) throw new ToolError(DM_UNAVAILABLE); return dm; };
    const gatewayFor = (channel: string): ChatGateway => isDirectMessageChannel(channel) ? needDm().gateway : web();
    const gateway: ChatGateway = {
      reply: (message, text, id, activity, ui) => gatewayFor(message.channel).reply(message, text, id, activity, ui),
      createTaskThread: () => web().createTaskThread(),
      typing: channel => gatewayFor(channel).typing(channel),
      react: async (message, emoji) => { await gatewayFor(message.channel).react?.(message, emoji); },
    };
    this.ports = {
      // Every tool call asks canManage. This workspace is not a Discord server, so a guild lookup would fail; nobody manages it.
      directory: { canManage: async () => false },
      gateway,
      validateChannel: async (message, channel) => {
        if (channel !== message.channel || !isPrivateChannel(channel)) throw new ToolError("Only this chat is available here.");
      },
      reply: async (message, text, id) => {
        if (isDirectMessageChannel(message.channel)) await needDm().reply(message, text, id); else await web().reply(message, text, id);
      },
      typing: channel => isDirectMessageChannel(channel) ? needDm().typing(channel) : web().typing(),
      findChannels: async () => "No channels here.",
      taskThread: async () => undefined,
      fetchHistory: (channel, before, limit) => isDirectMessageChannel(channel) ? needDm().fetchHistory(channel, before, limit) : Promise.resolve([]),
      fetchMessage: (channel, id) => isDirectMessageChannel(channel) ? needDm().fetchMessage(channel, id) : Promise.reject(new ToolError("Not available here.")),
      imageAttachments: (channel, id) => isDirectMessageChannel(channel) ? needDm().imageAttachments(channel, id) : Promise.resolve(undefined),
      sendStoredFile: (context, file, bytes) => isDirectMessageChannel(context.message.channel) ? needDm().sendStoredFile(context, file, bytes) : Promise.reject(new ToolError("Not available here.")),
      reminderChannel: () => undefined,
      registerTools: () => {},
    };
    this.workspace = new EngineWorkspace(deps.config, deps.store, deps.llm, server, deps.images, deps.usage, deps.access, deps.team, undefined, deps.degraded, this.ports);
    const sql = deps.store instanceof PostgresStore || deps.store instanceof SQLiteStore ? deps.store : undefined;
    if (sql && server === PERSONAL_SERVER) {
      const built = this.buildAssistant(sql);
      this.assistant = built.handle;
      this.assistantWorker = built.worker;
    }
  }

  /** Bud's parts on this workspace: tools and gate on its registry, a worker that submits wakes to it, and the console backend. */
  private buildAssistant(runtime: PostgresStore | SQLiteStore) {
    const { deps, workspace, server } = this;
    const store = assistantStoreOf(runtime);
    const notifier = deps.notifier ?? noopNotifier;
    const limits = async () => readAssistantLimits(deps.store);
    // Bud's chats are real web chats of the owner, opened for the bot, so the workspace answers a wake in them.
    const chats = {
      ensure: async (channel: string, owner: string, title: string) => {
        if (!channel.startsWith(PRIVATE_CHANNEL_PREFIX)) throw new ToolError("Not a web chat channel.");
        const id = channel.slice(PRIVATE_CHANNEL_PREFIX.length);
        if (!(await runtime.webChat(id))) {
          const at = Date.now();
          try { await runtime.insertWebChat({ id, server, owner, title: privateChatTitle(title), created: at, updated: at, deleted: false, storageServer: null, titleSource: "user" }); }
          catch (error) { if (!(await runtime.webChat(id))) throw error; }
        }
        workspace.openChat(channel);
      },
    };
    const memory = {
      remember: async (user: string, channel: string, text: string) => {
        // Notes live with the owner's personal memories, tagged with the sprout's memory channel.
        const origin = { id: `assistant-note:${randomUUID()}`, server, channel, author: user, text, surface: "web" as const };
        await runtime.remember(origin, text, { sourcePolicy: "independent", tags: [channel] });
      },
    };
    registerAssistantTools(workspace.tools, { store, notifier, limits, memory, chats });
    const gate = new Gate({ store, notifier, limits, registry: () => workspace.tools });
    workspace.tools.setAssistantGate(gate);
    const worker = new AssistantWorker({
      store, limits,
      submit: async message => {
        await chats.ensure(message.channel, message.author, message.channel === assistantHomeChannel(message.author) ? "Bud" : "Sprout");
        await workspace.submit(message);
      },
      overUsage: user => deps.usage.overGrace({ server, user }),
      triggerOwners: () => store.triggerOwners(),
    });
    const backend: AssistantBackend = {
      store, gate: { execute: async (id, user, always) => { await gate.execute(id, user, always); }, deny: (id, user) => gate.deny(id, user) },
      connectors: {
        list: async user => listConnectors(workspace.mcp, user),
        put: (user, { token, ...rest }) => putConnector(workspace.mcp, user, token === undefined ? rest : { ...rest, token }),
        remove: (user, name) => removeConnector(workspace.mcp, user, name),
      },
      limits, ensureHomeChat: (user: string) => ensureHomeChat(chats, user),
    };
    return { handle: { backend, gate, store, limits }, worker };
  }

  /** Starts work for this workspace: the platform-neutral steps of DiscordServer.ready, and reopens the live personal chats. */
  async ready(botUser: string): Promise<void> {
    const { store } = this.deps, server = this.server, workspace = this.workspace;
    await store.setSetting(server, "context_bot_author", botUser);
    void workspace.purgeAndIndex().catch(error => logError("Database startup indexing failed", error, { server }));
    if (server === PERSONAL_SERVER) for (const channel of await store.liveWebChatChannels(PERSONAL_SERVER)) workspace.openChat(channel);
    workspace.worker.start();
    // Personal connectors (Bud) reconnect in the background.
    void workspace.mcp.restore().catch(error => logError("mcp_restore_failed", error, { stage: "MCP restore", server }));
    this.assistantWorker?.start();
    this.codeMaintenance = startCodeMaintenance(store, server);
    this.attachSweep = startAttachLinkSweep(store, this.deps.images, server);
    workspace.reminders.start();
    workspace.schedules.start();
    workspace.fixWatches?.start();
  }

  async stop(): Promise<void> {
    const workspace = this.workspace;
    this.codeMaintenance?.();
    this.attachSweep?.();
    await workspace.reminders.stop();
    await workspace.schedules.stop();
    await workspace.fixWatches?.stop();
    await this.assistantWorker?.stop();
    await workspace.worker.stop();
    await workspace.mcp.close();
  }

  close(): void { void this.stop().catch(error => logError("personal_server_stop_failed", error, { server: this.server })); }
}
