/** Users that Slopbot does not answer in one server, until a time. The Slopbot team sets them with the mute_users tool. */
export const MUTED_USERS_KEY = "muted_users";
export const MAX_MUTE_MINUTES = 60 * 24 * 365;

/** User ID to the time (ms) when the mute ends. Ended mutes are left out. */
export function mutedUsers(saved: unknown, now = Date.now()): Record<string, number> {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved as Record<string, unknown>).filter(([user, until]) => /^\d{17,20}$/.test(user) && typeof until === "number" && until > now) as [string, number][]);
}

/** A Discord user ID from an ID or a mention such as <@123>. */
export function userId(raw: unknown): string | undefined {
  const match = String(raw ?? "").trim().match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return match ? match[1] ?? match[2] : undefined;
}
