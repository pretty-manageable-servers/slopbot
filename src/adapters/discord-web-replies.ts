import { ChannelType, WebhookClient, type Client } from "discord.js";
import { WEBHOOK_NAME, type WebHook, type WebReplyDiscord } from "../web-replies.js";

/** Web reply Discord calls through the bot's discord.js client. */
export function discordWebReplies(client: Client): WebReplyDiscord {
  return {
    async channel(server, channel) {
      const found = await client.channels.fetch(channel).catch(() => undefined);
      if (!found || found.isDMBased() || found.guildId !== server) return undefined;
      if (found.isThread()) return found.parentId ? { parent: found.parentId, thread: true } : undefined;
      return found.type === ChannelType.GuildText ? { parent: found.id, thread: false } : undefined;
    },
    async member(server, user) {
      const guild = await client.guilds.fetch(server).catch(() => undefined);
      const member = await guild?.members.fetch({ user, force: true }).catch(() => undefined);
      if (!guild || !member) return undefined;
      const name = member.user.globalName ?? member.user.username;
      return {
        name: member.displayName,
        avatarURL: member.displayAvatarURL({ size: 128 }),
        aliases: [member.user.username, ...(member.user.globalName ? [member.user.globalName] : [])],
        identity: { discord_handle: member.user.username, discord_name: name, server_nickname: member.displayName, server_name: guild.name },
      };
    },
    async createWebhook(parent) {
      const channel = await client.channels.fetch(parent);
      if (channel?.type !== ChannelType.GuildText) throw new Error("Web replies need a server text channel.");
      const hook = await channel.createWebhook({ name: WEBHOOK_NAME });
      if (!hook.token) throw new Error("Discord did not return a webhook token.");
      return { id: hook.id, token: hook.token };
    },
    async deleteWebhook(_parent, id) {
      const hook = await client.fetchWebhook(id).catch(() => undefined);
      await hook?.delete();
    },
    async send(hook: WebHook, post) {
      const sent = await new WebhookClient({ id: hook.id, token: hook.token }).send({
        content: post.text, username: post.username, avatarURL: post.avatarURL,
        allowedMentions: { parse: [] }, ...(post.threadId ? { threadId: post.threadId } : {}),
      });
      return sent.id;
    },
  };
}
