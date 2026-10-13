import { ChannelType, Events, PermissionFlagsBits, type Client } from "discord.js";
import type { ChannelAccess, ChannelAccessSource } from "../channel-access.js";
import { isPrivateChannel } from "../private-chat.js";

/** Reads live permissions through the bot's discord.js client: guild member, then channel.permissionsFor(member). */
export function discordChannelAccessSource(client: Client): ChannelAccessSource {
  return {
    async facts(server, channelId, user) {
      // A private chat ID is not a Discord channel. It never reaches the Discord API.
      if (isPrivateChannel(channelId)) return undefined;
      const guild = await client.guilds.fetch(server).catch(() => undefined);
      const member = await guild?.members.fetch({ user, force: true }).catch(() => undefined);
      if (!member) return undefined;
      const channel = await client.channels.fetch(channelId).catch(() => undefined);
      if (!channel || !("permissionsFor" in channel) || channel.guildId !== server) return undefined;
      const permissions = channel.permissionsFor(member);
      const has = (flag: bigint) => permissions?.has(flag) ?? false;
      let threadMember = false;
      if (channel.isThread() && channel.type === ChannelType.PrivateThread) threadMember = await channel.members.fetch(user).then(() => true, () => false);
      return {
        thread: channel.isThread(),
        privateThread: channel.isThread() && channel.type === ChannelType.PrivateThread,
        viewChannel: has(PermissionFlagsBits.ViewChannel),
        readMessageHistory: has(PermissionFlagsBits.ReadMessageHistory),
        sendMessages: has(PermissionFlagsBits.SendMessages),
        sendMessagesInThreads: has(PermissionFlagsBits.SendMessagesInThreads),
        threadMember,
      };
    },
  };
}

/** Clears cached answers when Discord reports a change that can alter them. */
export function wireChannelAccessEvents(client: Client, access: ChannelAccess): void {
  client.on(Events.GuildMemberUpdate, (_old, member) => access.clearUser(member.guild.id, member.id));
  client.on(Events.GuildMemberRemove, member => access.clearUser(member.guild.id, member.id));
  client.on(Events.ChannelUpdate, (_old, channel) => access.clearChannel(channel.id));
  client.on(Events.ThreadUpdate, (_old, thread) => access.clearChannel(thread.id));
  client.on(Events.ThreadDelete, thread => access.clearChannel(thread.id));
  client.on(Events.ChannelDelete, channel => access.clearChannel(channel.id));
  client.on(Events.GuildRoleUpdate, (_old, role) => access.clearServer(role.guild.id));
}
