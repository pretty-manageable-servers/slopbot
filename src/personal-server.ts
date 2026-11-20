import type { ChatGateway } from "./bot.js";
import { WebChatGateway } from "./engine/web-chat-gateway.js";
import { EngineWorkspace } from "./engine/workspace.js";
import { startAttachLinkSweep, type AttachQueue } from "./attach-file.js";
import { startCodeMaintenance } from "./code-maintenance.js";
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

/** Discord DM delivery for the personal workspace. The Discord client gives it (WP2); absent in local mode. */
export interface PersonalDmPorts extends Pick<WorkspacePorts, "reply" | "typing" | "fetchHistory" | "fetchMessage" | "imageAttachments" | "sendStoredFile"> { readonly gateway: ChatGateway }
export interface PersonalServerDeps { config: Config; store: RuntimeStore; llm: LLM; usage: UsageMeter; access: ChannelAccess;
  team: Pick<TeamAdmins, "canEdit">; directory: Directory; images?: S3StorageProvider; degraded?: DegradedRouting; dm?: PersonalDmPorts;
  /** INCOGNITO_SERVER for private chats. Default PERSONAL_SERVER. */ server?: string }

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

  constructor(private readonly deps: PersonalServerDeps) {
    const server = this.server = deps.server ?? PERSONAL_SERVER;
    const { directory, dm } = deps;
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
      directory,
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
  }

  /** Starts work for this workspace: the platform-neutral steps of DiscordServer.ready, and reopens the live personal chats. */
  async ready(botUser: string): Promise<void> {
    const { store } = this.deps, server = this.server, workspace = this.workspace;
    await store.setSetting(server, "context_bot_author", botUser);
    void workspace.purgeAndIndex().catch(error => logError("Database startup indexing failed", error, { server }));
    if (server === PERSONAL_SERVER) for (const channel of await store.liveWebChatChannels(PERSONAL_SERVER)) workspace.openChat(channel);
    workspace.worker.start();
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
    await workspace.worker.stop();
    await workspace.mcp.close();
  }

  close(): void { void this.stop().catch(error => logError("personal_server_stop_failed", error, { server: this.server })); }
}
