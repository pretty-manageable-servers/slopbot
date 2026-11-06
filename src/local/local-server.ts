import type { S3StorageProvider } from "../adapters/s3-storage.js";
import type { ChannelAccess } from "../channel-access.js";
import type { Config } from "../config.js";
import type { Directory } from "../engine/api.js";
import type { DegradedRouting } from "../engine/ports.js";
import type { EngineWorkspace } from "../engine/workspace.js";
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
  readonly workspace!: EngineWorkspace;
  constructor(_deps: LocalServerDeps) { throw new Error("not built"); }
  ready(_botUser: string): Promise<void> { throw new Error("not built"); }
  stop(): Promise<void> { throw new Error("not built"); }
}
