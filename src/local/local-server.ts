import type { S3StorageProvider } from "../adapters/s3-storage.js";
import type { ChannelAccess } from "../channel-access.js";
import type { Config } from "../config.js";
import type { Directory } from "../engine/api.js";
import type { DegradedRouting, WorkspacePorts } from "../engine/ports.js";
import { WebChatGateway } from "../engine/web-chat-gateway.js";
import { EngineWorkspace } from "../engine/workspace.js";
import { startAttachLinkSweep, type AttachQueue } from "../attach-file.js";
import { ToolError, logError } from "../errors.js";
import { isPrivateChannel } from "../private-chat.js";
import { LocalDiskStorage } from "../web-chat-images.js";
import { LOCAL_ONLY } from "./world.js";
import type { LLM } from "../ports.js";
import type { RuntimeStore } from "../runtime-store.js";
import type { TeamAdmins } from "../team-admins.js";
import type { UsageMeter } from "../usage-meter.js";

export interface LocalServerDeps {
  config: Config; store: RuntimeStore; llm: LLM; server: string; usage: UsageMeter; access: ChannelAccess;
  team: Pick<TeamAdmins, "canEdit">; directory: Directory; images?: S3StorageProvider; degraded?: DegradedRouting;
}

/** One fixture server's workspace, with WorkspacePorts that serve private web chats only. */
export class LocalServer {
  readonly workspace: EngineWorkspace;
  /** What the workspace calls back into; public so tests can exercise the port rules directly. */
  readonly ports: WorkspacePorts;
  private gateway: WebChatGateway | undefined;
  private attachSweep: (() => void) | undefined;

  constructor(private readonly deps: LocalServerDeps) {
    const { server, directory } = deps;
    // The workspace reads ports.gateway while it is built, before this.workspace exists, so the queue is reached late.
    const lateQueue = { take: (run: string) => this.workspace.attachQueue.take(run) } as AttachQueue;
    const gateway = () => this.gateway ??= new WebChatGateway(deps.store, server, { queue: lateQueue, storage: deps.images ?? new LocalDiskStorage() });
    const localOnly = async (): Promise<never> => { throw new ToolError(LOCAL_ONLY); };
    const ports: WorkspacePorts = this.ports = {
      directory,
      get gateway() { return gateway(); },
      validateChannel: async (message, channel) => {
        if (!isPrivateChannel(channel) || !await directory.isMember(message.author, server)) throw new ToolError(LOCAL_ONLY);
      },
      reply: async (message, text, id) => { await gateway().reply(message, text, id); },
      typing: () => gateway().typing(),
      findChannels: async () => "No channels in local mode.",
      taskThread: async () => undefined,
      fetchHistory: async () => [],
      fetchMessage: localOnly,
      imageAttachments: async () => undefined,
      sendStoredFile: localOnly,
      reminderChannel: () => undefined,
      registerTools: () => {},
    };
    this.workspace = new EngineWorkspace(deps.config, deps.store, deps.llm, server, deps.images, deps.usage, deps.access, deps.team, undefined, deps.degraded, ports);
  }

  /** Starts work for this server: the platform-neutral steps of DiscordServer.ready. */
  async ready(botUser: string): Promise<void> {
    const { store, server } = this.deps, workspace = this.workspace;
    await store.setSetting(server, "context_bot_author", botUser);
    void workspace.purgeAndIndex().catch(error => logError("Database startup indexing failed", error, { server }));
    for (const channel of await store.liveWebChatChannels(server)) workspace.openChat(channel);
    workspace.worker.start();
    // startCodeMaintenance lives in adapters/discord-code.ts, which imports discord.js, so local mode skips it.
    this.attachSweep = startAttachLinkSweep(store, this.deps.images, server);
    workspace.reminders.start();
    workspace.schedules.start();
    workspace.fixWatches?.start();
  }

  async stop(): Promise<void> {
    const workspace = this.workspace;
    this.attachSweep?.();
    await workspace.reminders.stop();
    await workspace.schedules.stop();
    await workspace.fixWatches?.stop();
    await workspace.worker.stop();
    await workspace.mcp.close();
  }
}
