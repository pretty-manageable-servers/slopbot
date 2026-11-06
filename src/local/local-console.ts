import { pageItems, type AdminPanel, type ServerPage } from "../admin-panel.js";
import type { ConsoleAdmin, ConsoleBackend } from "../clients/web/web-console.js";
import type { Config } from "../config.js";
import { ToolError } from "../errors.js";
import type { MemberDirectory } from "../member-directory.js";
import { serverSettingsSnapshot } from "../server-settings.js";
import type { RuntimeStore } from "../runtime-store.js";
import type { TeamAdmins } from "../team-admins.js";
import { usageView } from "../user-limiter.js";
import type { UsageMeter } from "../usage-meter.js";
import { LOCAL_ONLY, type LocalWorld } from "./world.js";

export type LocalConsoleBackend = Pick<ConsoleBackend, "canSignIn" | "servers" | "profile" | "snapshot" | "usage" | "useReset" | "invoke" | "mcp" | "transcripts" | "inbox" | "setTranscript" | "reply">;

/** The console backend from the fixture. Servers-tab calls answer LOCAL_ONLY. */
export function localConsoleBackend(deps: { world: LocalWorld; config: Config; store: RuntimeStore; members: MemberDirectory; usage: UsageMeter }): LocalConsoleBackend {
  const { world, config, store, usage: meter } = deps;
  const userOf = (id: string) => world.users.find(user => user.id === id);
  const listServers = (user: string) => {
    const found = userOf(user);
    return found ? world.servers.filter(server => found.servers.includes(server.id)).map(server => ({ id: server.id, name: server.name, icon: server.icon, admin: found.manage.includes(server.id) })) : [];
  };
  const requireMember = (user: string, server: string) => {
    if (!listServers(user).some(item => item.id === server)) throw new ToolError("You and Slopbot are not both in that server.", "rejected");
  };
  return {
    async canSignIn(user) {
      return listServers(user).length > 0;
    },
    async servers(user) {
      return listServers(user);
    },
    async profile(user) {
      const found = userOf(user);
      return found ? { displayName: found.name, avatarUrl: found.avatarUrl } : undefined;
    },
    async snapshot(user, server) {
      const found = userOf(user), servers = listServers(user);
      if (!found || servers.length === 0) return { user, servers, server: null };
      const chosen = server === undefined ? servers[0] : servers.find(item => item.id === server);
      if (!chosen) throw new ToolError("Not a member of this server.");
      return {
        server: { id: chosen.id, name: chosen.name }, user, admin: chosen.admin, channels: [],
        me: { id: user, displayName: found.name, avatarUrl: found.avatarUrl },
        profile: await store.profile(chosen.id, user), mcp: null,
        settings: chosen.admin ? serverSettingsSnapshot(config, store, chosen.id) : null,
        servers,
      };
    },
    async usage(user, server) {
      requireMember(user, server);
      return usageView(await meter.limiter.usage(user));
    },
    async useReset(user, server, kind) {
      requireMember(user, server);
      if (!await meter.limiter.useReset(user, kind)) throw new ToolError(`You have no banked ${kind === "5h" ? "5-hour" : "weekly"} reset.`);
      return usageView(await meter.limiter.usage(user));
    },
    async invoke() { throw new ToolError(LOCAL_ONLY); },
    async mcp() { throw new ToolError(LOCAL_ONLY); },
    async transcripts() { throw new ToolError(LOCAL_ONLY); },
    inbox: {
      async list() { throw new ToolError(LOCAL_ONLY); },
      async done() { throw new ToolError(LOCAL_ONLY); },
    },
    async setTranscript() { throw new ToolError(LOCAL_ONLY); },
    async reply() { throw new ToolError(LOCAL_ONLY); },
  };
}

/** The admin panel backend from the fixture. */
export function localConsoleAdmin(deps: { world: LocalWorld; team: TeamAdmins; panel: AdminPanel }): ConsoleAdmin {
  const { world, team, panel } = deps;
  return {
    role: user => team.role(user),
    canEdit: user => team.canEdit(user),
    async servers(page: ServerPage) {
      return pageItems(world.servers.map(server => ({ id: server.id, name: server.name, icon: server.icon, channelCount: 0, transcriptsOn: 0 })), page);
    },
    async serverChannels() {
      return [];
    },
    serverInfo(server) {
      const found = world.servers.find(item => item.id === server);
      return { name: found?.name ?? server, icon: found?.icon ?? null };
    },
    async setTranscript() { throw new ToolError(LOCAL_ONLY); },
    async rotateWebhook() { throw new ToolError(LOCAL_ONLY); },
    panel,
  };
}
