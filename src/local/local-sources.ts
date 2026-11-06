import type { ChannelAccessSource } from "../channel-access.js";
import type { Directory } from "../engine/api.js";
import type { MemberDirectory, MemberProfile, MemberSource } from "../member-directory.js";
import type { TeamSource } from "../team-admins.js";
import type { LocalWorld } from "./world.js";

/** Members of the fixture servers, in place of the Discord member list. */
export function localMemberSource(_world: LocalWorld): MemberSource {
  throw new Error("not built");
}

/** Access facts for private chat channels only. Other channels: undefined. */
export function localChannelAccessSource(_world: LocalWorld): ChannelAccessSource {
  throw new Error("not built");
}

/** The team owner and members from the fixture. */
export function localTeamSource(_world: LocalWorld): TeamSource {
  throw new Error("not built");
}

/** Membership and Manage Server from the fixture. */
export class LocalDirectory implements Directory {
  constructor(private readonly world: LocalWorld, private readonly members: MemberDirectory) {}
  isMember(_user: string, _server: string): Promise<boolean> { void this.world; throw new Error("not built"); }
  canManage(_user: string, _server: string): Promise<boolean> { throw new Error("not built"); }
  profiles(_server: string, _users: readonly string[]): Promise<Map<string, MemberProfile>> { void this.members; throw new Error("not built"); }
  channelName(_server: string, _channel: string): Promise<string | undefined> { throw new Error("not built"); }
}
