import { ChannelType, PermissionFlagsBits, WebhookClient, type Client } from "discord.js";
import { MissingWebhookPermissionError, UnknownWebhookError, WEBHOOK_NAME, type WebHook, type WebReplyDiscord } from "../web-replies.js";

const UNKNOWN_CHANNEL = 10003, UNKNOWN_WEBHOOK = 10015, MISSING_PERMISSIONS = 50013;

/** Discord error fields. A discord.js DiscordAPIError has `code` and `status`; anything else has neither. */
function discordField(error: unknown, field: "code" | "status"): unknown {
  return typeof error === "object" && error !== null && field in error ? (error as Record<string, unknown>)[field] : undefined;
}
/** The webhook is gone: code 10015, or HTTP 404 that is not an unknown channel (a deleted thread). */
function isUnknownWebhook(error: unknown): boolean {
  const code = discordField(error, "code");
  return code === UNKNOWN_WEBHOOK || (discordField(error, "status") === 404 && code !== UNKNOWN_CHANNEL);
}

/** Web reply Discord calls through the bot's discord.js client. */
export function discordWebReplies(client: Client): WebReplyDiscord {
  return {
    async channel(server, channel) {
      const found = await client.channels.fetch(channel).catch(() => undefined);
      if (!found || found.isDMBased() || found.guildId !== server) return undefined;
      if (found.isThread()) return found.parentId ? { parent: found.parentId, thread: true } : undefined;
      // A voice channel has its own text chat. Voice transcripts are posted there.
      return found.type === ChannelType.GuildText || found.type === ChannelType.GuildVoice ? { parent: found.id, thread: false } : undefined;
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
    async canManageWebhooks(server, parent) {
      const channel = await client.channels.fetch(parent).catch(() => undefined);
      if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildVoice) return false;
      const guild = await client.guilds.fetch(server).catch(() => undefined);
      const me = await guild?.members.fetchMe({ force: true }).catch(() => undefined);
      return Boolean(me && channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks));
    },
    async createWebhook(parent) {
      const channel = await client.channels.fetch(parent);
      if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildVoice) throw new Error("Web replies need a server text or voice channel.");
      let hook;
      try {
        hook = await channel.createWebhook({ name: WEBHOOK_NAME });
      } catch (error) {
        if (discordField(error, "code") === MISSING_PERMISSIONS) throw new MissingWebhookPermissionError("Slopbot lacks Manage Webhooks in this channel.");
        throw error;
      }
      if (!hook.token) throw new Error("Discord did not return a webhook token.");
      return { id: hook.id, token: hook.token };
    },
    async deleteWebhook(_parent, id) {
      const hook = await client.fetchWebhook(id).catch(() => undefined);
      await hook?.delete();
    },
    async send(hook: WebHook, post) {
      try {
        const sent = await new WebhookClient({ id: hook.id, token: hook.token }).send({
          content: post.text, username: post.username, avatarURL: post.avatarURL,
          allowedMentions: { parse: [] }, ...(post.threadId ? { threadId: post.threadId } : {}),
        });
        return sent.id;
      } catch (error) {
        if (isUnknownWebhook(error)) throw new UnknownWebhookError("Discord does not know the web reply webhook.");
        throw error;
      }
    },
    async sendAsBot(channel, content) {
      const target = await client.channels.fetch(channel);
      if (!target?.isSendable()) throw new Error("Slopbot cannot send messages in that channel.");
      const sent = await target.send({ content, allowedMentions: { parse: [] } });
      return sent.id;
    },
  };
}
