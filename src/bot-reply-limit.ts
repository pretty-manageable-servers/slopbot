/** How often Slopbot answers other bots in one channel. Team editors change it in Bot admin. */
export interface BotReplyLimit { replies: number; minutes: number }
/** A limit that is used until `until` (epoch ms). After that, the normal limit is used again. */
export interface TemporaryBotReplyLimit extends BotReplyLimit { until: number }
export interface BotReplyLimits extends BotReplyLimit { temporary?: TemporaryBotReplyLimit }

export const BOT_REPLY_LIMIT_KEY = "bot_reply_limit";
export const DEFAULT_BOT_REPLY_LIMIT: BotReplyLimit = { replies: 3, minutes: 10 };
export const MAX_BOT_REPLIES = 1000;
export const MAX_BOT_REPLY_MINUTES = 1440;
/** The longest time a temporary limit can last: 7 days. */
export const MAX_TEMPORARY_MINUTES = 10080;

function validLimit(saved: unknown): BotReplyLimit | undefined {
  if (!saved || typeof saved !== "object") return undefined;
  const { replies, minutes } = saved as Record<string, unknown>;
  if (!Number.isSafeInteger(replies) || (replies as number) < 0 || (replies as number) > MAX_BOT_REPLIES) return undefined;
  if (!Number.isSafeInteger(minutes) || (minutes as number) < 1 || (minutes as number) > MAX_BOT_REPLY_MINUTES) return undefined;
  return { replies: replies as number, minutes: minutes as number };
}

/** The saved normal limit and the temporary limit, if it did not end. */
export function botReplyLimits(saved: unknown, now = Date.now()): BotReplyLimits {
  const base = validLimit(saved) ?? DEFAULT_BOT_REPLY_LIMIT;
  const raw = saved && typeof saved === "object" ? (saved as Record<string, unknown>).temporary : undefined;
  const temporary = validLimit(raw);
  const until = (raw as Record<string, unknown> | undefined)?.until;
  if (!temporary || typeof until !== "number" || until <= now) return { ...base };
  return { ...base, temporary: { ...temporary, until } };
}

/** The limit to use now: the temporary limit until it ends, then the normal limit. */
export function botReplyLimit(saved: unknown, now = Date.now()): BotReplyLimit {
  const limits = botReplyLimits(saved, now);
  return limits.temporary ? { replies: limits.temporary.replies, minutes: limits.temporary.minutes } : { replies: limits.replies, minutes: limits.minutes };
}

export function describeBotReplyLimits(limits: BotReplyLimits): string {
  const text = (limit: BotReplyLimit) => limit.replies === 0 ? "does not answer other bots" : `answers other bots at most ${limit.replies} times in ${limit.minutes} minutes per channel`;
  if (!limits.temporary) return `Slopbot ${text(limits)}.`;
  return `Slopbot ${text(limits.temporary)} until <t:${Math.floor(limits.temporary.until / 1000)}:f>. After that, Slopbot ${text(limits)}.`;
}
