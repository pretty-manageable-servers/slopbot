import type { ChannelAccessSource } from "../channel-access.js";
import type { Directory } from "../engine/api.js";
import type { MemberDirectory, MemberProfile, MemberRecord, MemberSource, MemberUser } from "../member-directory.js";
import { isPrivateChannel } from "../private-chat.js";
import type { TeamSource } from "../team-admins.js";
import type { LocalUser, LocalWorld } from "./world.js";

const DEFAULT_AVATAR = "/console/favicon.svg";

function userById(world: LocalWorld, id: string): LocalUser | undefined {
  return world.users.find(user => user.id === id);
}

function memberUserOf(user: LocalUser): MemberUser {
  return { id: user.id, username: user.name, globalName: user.name, avatarUrl: user.avatarUrl, defaultAvatarUrl: DEFAULT_AVATAR };
}

function recordOf(user: LocalUser): MemberRecord {
  return { user: memberUserOf(user), nickname: null, avatarUrl: null };
}

/** Members of the fixture servers, in place of the Discord member list. */
export function localMemberSource(world: LocalWorld): MemberSource {
  const inServer = (server: string) => world.users.filter(user => user.servers.includes(server));
  return {
    async members(server, ids) {
      const found = new Map<string, MemberRecord>();
      for (const id of ids) {
        const user = userById(world, id);
        if (user?.servers.includes(server)) found.set(id, recordOf(user));
      }
      return found;
    },
    async user(id) {
      const user = userById(world, id);
      if (!user) throw new Error("Unknown local user");
      return memberUserOf(user);
    },
    async search(server, query, limit) {
      const needle = query.toLowerCase();
      return inServer(server).filter(user => user.name.toLowerCase().startsWith(needle)).slice(0, limit).map(recordOf);
    },
  };
}

/** Access facts for private chat channels only. Other channels: undefined. */
export function localChannelAccessSource(world: LocalWorld): ChannelAccessSource {
  return {
    async facts(server, channel, user) {
      if (!userById(world, user)?.servers.includes(server) || !isPrivateChannel(channel)) return undefined;
      return { thread: true, privateThread: true, viewChannel: true, readMessageHistory: true, sendMessages: true, sendMessagesInThreads: true, threadMember: true };
    },
  };
}

/** The team owner and members from the fixture. */
export function localTeamSource(world: LocalWorld): TeamSource {
  return {
    async load() {
      const owner = world.users.find(user => user.team === "owner");
      const members = world.users.flatMap(user => user.team && user.id !== owner?.id ? [{ id: user.id, role: user.team, accepted: true }] : []);
      return { ownerId: owner?.id, members };
    },
  };
}

/** Membership and Manage Server from the fixture. */
export class LocalDirectory implements Directory {
  constructor(private readonly world: LocalWorld, private readonly members: MemberDirectory) {}
  async isMember(user: string, server: string): Promise<boolean> {
    return userById(this.world, user)?.servers.includes(server) ?? false;
  }
  async canManage(user: string, server: string): Promise<boolean> {
    return userById(this.world, user)?.manage.includes(server) ?? false;
  }
  profiles(server: string, users: readonly string[]): Promise<Map<string, MemberProfile>> {
    return this.members.profiles(server, users);
  }
  async channelName(_server: string, _channel: string): Promise<string | undefined> {
    return undefined;
  }
}
