import type { AdminPanel } from "../admin-panel.js";
import type { ConsoleAdmin, ConsoleBackend } from "../clients/web/web-console.js";
import type { Config } from "../config.js";
import type { MemberDirectory } from "../member-directory.js";
import type { RuntimeStore } from "../runtime-store.js";
import type { TeamAdmins } from "../team-admins.js";
import type { UsageMeter } from "../usage-meter.js";
import type { LocalWorld } from "./world.js";

export type LocalConsoleBackend = Pick<ConsoleBackend, "canSignIn" | "servers" | "profile" | "snapshot" | "usage" | "useReset" | "invoke" | "mcp" | "transcripts" | "inbox" | "setTranscript" | "reply">;

/** The console backend from the fixture. Servers-tab calls answer LOCAL_ONLY. */
export function localConsoleBackend(_deps: { world: LocalWorld; config: Config; store: RuntimeStore; members: MemberDirectory; usage: UsageMeter }): LocalConsoleBackend {
  throw new Error("not built");
}

/** The admin panel backend from the fixture. */
export function localConsoleAdmin(_deps: { world: LocalWorld; team: TeamAdmins; panel: AdminPanel }): ConsoleAdmin {
  throw new Error("not built");
}
