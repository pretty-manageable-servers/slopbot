import type { ChatGateway } from "./bot.js";
import type { Config } from "./config.js";
import type { LLM } from "./ports.js";
import type { RuntimeStore } from "./runtime-store.js";
import type { UsageMeter } from "./usage-meter.js";
import type { ChannelAccess } from "./channel-access.js";
import type { TeamAdmins } from "./team-admins.js";
import type { Directory } from "./engine/api.js";
import type { EngineWorkspace } from "./engine/workspace.js";
import type { DegradedRouting, WorkspacePorts } from "./engine/ports.js";
import type { S3StorageProvider } from "./adapters/s3-storage.js";

/** Discord DM delivery for the personal workspace. The Discord client gives it (WP2); absent in local mode. */
export interface PersonalDmPorts extends Pick<WorkspacePorts, "reply" | "typing" | "fetchHistory" | "fetchMessage" | "imageAttachments" | "sendStoredFile"> { readonly gateway: ChatGateway }
export interface PersonalServerDeps { config: Config; store: RuntimeStore; llm: LLM; usage: UsageMeter; access: ChannelAccess;
  team: Pick<TeamAdmins, "canEdit">; directory: Directory; images?: S3StorageProvider; degraded?: DegradedRouting; dm?: PersonalDmPorts;
  /** INCOGNITO_SERVER for private chats. Default PERSONAL_SERVER. */ server?: string }

/** The personal workspace. WP1 builds it; until then the constructor throws. */
export class PersonalServer {
  readonly workspace: EngineWorkspace;
  readonly ports: WorkspacePorts;
  constructor(_deps: PersonalServerDeps) { throw new Error("WP1"); }
  async ready(_botUser: string): Promise<void> { throw new Error("WP1"); }
  close(): void { throw new Error("WP1"); }
}
