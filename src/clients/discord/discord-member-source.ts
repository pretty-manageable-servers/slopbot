import { GatewayIntentBits, IntentsBitField, type Client, type GuildMember, type User } from "discord.js";
import { PARALLEL, mapLimit, type MemberRecord, type MemberSource, type MemberUser } from "../../member-directory.js";

const BATCH = 100;

function userOf(user: User): MemberUser {
  return { id: user.id, username: user.username, globalName: user.globalName, avatarUrl: user.avatarURL({ size: 64 }) ?? null, defaultAvatarUrl: user.defaultAvatarURL };
}

function recordOf(member: GuildMember): MemberRecord {
  return { user: userOf(member.user), nickname: member.nickname, avatarUrl: member.avatarURL({ size: 64 }) ?? null };
}

/**
 * The discord.js side. A batch fetch by user ID needs the GuildMembers gateway intent. Without it,
 * each member is fetched by REST, which needs no privileged intent.
 */
export function discordMemberSource(client: Client): MemberSource {
  const batchAllowed = () => Boolean(client.options?.intents) && new IntentsBitField(client.options.intents).has(GatewayIntentBits.GuildMembers);
  const guildOf = async (server: string) => client.guilds.cache.get(server) ?? await client.guilds.fetch(server);
  return {
    async members(server, ids) {
      const guild = await guildOf(server);
      const found = new Map<string, MemberRecord>();
      const single: string[] = [];
      if (batchAllowed()) {
        for (let offset = 0; offset < ids.length; offset += BATCH) {
          const chunk = ids.slice(offset, offset + BATCH);
          const fetched = await guild.members.fetch({ user: chunk }).catch(() => undefined);
          if (fetched) for (const member of fetched.values()) found.set(member.id, recordOf(member));
          else single.push(...chunk);
        }
      } else single.push(...ids);
      await mapLimit(single, PARALLEL, async id => {
        const member = await guild.members.fetch(id).catch(() => undefined);
        if (member) found.set(id, recordOf(member));
      });
      return found;
    },
    async user(id) {
      return userOf(await client.users.fetch(id));
    },
    async search(server, query, limit) {
      const guild = await guildOf(server);
      const found = await guild.members.search({ query, limit });
      return [...found.values()].map(recordOf);
    },
  };
}
