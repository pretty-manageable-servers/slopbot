/** How often Slopbot answers other bots in one channel. Team editors change it in Bot admin. */
export interface BotReplyLimit { replies: number; minutes: number }

export const BOT_REPLY_LIMIT_KEY = "bot_reply_limit";
export const DEFAULT_BOT_REPLY_LIMIT: BotReplyLimit = { replies: 3, minutes: 10 };
export const MAX_BOT_REPLIES = 1000;
export const MAX_BOT_REPLY_MINUTES = 1440;

/** The saved limit, or the default when nothing valid is saved. */
export function botReplyLimit(saved: unknown): BotReplyLimit {
  if (!saved || typeof saved !== "object") return DEFAULT_BOT_REPLY_LIMIT;
  const { replies, minutes } = saved as Record<string, unknown>;
  if (!Number.isSafeInteger(replies) || (replies as number) < 0 || (replies as number) > MAX_BOT_REPLIES) return DEFAULT_BOT_REPLY_LIMIT;
  if (!Number.isSafeInteger(minutes) || (minutes as number) < 1 || (minutes as number) > MAX_BOT_REPLY_MINUTES) return DEFAULT_BOT_REPLY_LIMIT;
  return { replies: replies as number, minutes: minutes as number };
}
