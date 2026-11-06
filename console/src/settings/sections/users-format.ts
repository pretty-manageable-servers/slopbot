// Money, usage and override helpers for the admin Users section. Pure functions, so users-format.test.ts can check them
// without rendering anything. The bot keeps money in micro-dollars (1 dollar is 1000000).
import type { UserLimitOverride, UserRow, UserUsageWindow } from "../../api-types";

export type WindowKind = "5h" | "week";

/** Avatars come from Discord's CDN only, as the old console allowed. */
const AVATAR_HOST = "https://cdn.discordapp.com/";
/** The most a limit can be, in dollars. The old console had the same cap. */
const MAX_DOLLARS = 1_000_000;

/** Micro-dollars to dollars: 1500000 is 1.5. */
export const toDollars = (micros: number) => micros / 1_000_000;
/** Dollars to micro-dollars, rounded to a whole micro: 1.5 is 1500000. */
export const toMicros = (dollars: number) => Math.round(dollars * 1_000_000);
/** Money text with two decimals: "$1.23". */
export const money = (micros: number) => `$${toDollars(micros).toFixed(2)}`;
/** A local date and time for a timestamp in ms. */
export const when = (ms: number) => new Date(ms).toLocaleString();

/** The form text of a limit: "" when there is no override (blank means the global limit), else dollars as typed. */
export const limitText = (micros: number | null) => (micros === null ? "" : String(toDollars(micros)));

/** Why a limit entry cannot be saved, or null when it can. A blank entry is valid: it means the global limit. */
export function limitError(text: string): string | null {
  if (text.trim() === "") return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 && amount <= MAX_DOLLARS ? null : `Enter a dollar amount from 0 to ${MAX_DOLLARS.toLocaleString("en-US")}.`;
}

const limitMicros = (text: string) => (text.trim() === "" ? null : toMicros(Number(text)));

export interface OverrideBody extends UserLimitOverride { user: string }

/**
 * The body of users/override from the two form entries. A blank entry is null, which is the global limit. Both
 * blank is the body that removes the override. The entries must pass limitError first.
 */
export function overrideBody(user: string, fiveHour: string, week: string): OverrideBody {
  return { user, five_hour_cost_micros: limitMicros(fiveHour), week_cost_micros: limitMicros(week) };
}

/** The window of one kind. A user with no spend yet has no window, so a zero window stands in. */
export function windowOf(view: Pick<UserRow, "windows">, kind: WindowKind): UserUsageWindow {
  return view.windows.find((win) => win.kind === kind) ?? { kind, spent: 0, limit: 0, resetAt: null, banked: 0 };
}

/** Whether a window has spend or a running reset clock. The list shows a dash for the others. */
export const hasWindow = (win: UserUsageWindow) => win.spent > 0 || win.resetAt !== null;

/** Spent share of a limit in whole percent, capped at 100. 0 when there is no limit. */
export function sharePct(win: Pick<UserUsageWindow, "spent" | "limit">) {
  if (!win.limit) return 0;
  return Math.min(100, Math.round((win.spent * 100) / win.limit));
}

/** "$1.23 of $5.00", or "$1.23 of no limit" when the limit is 0. */
export const usageText = (win: UserUsageWindow) => `${money(win.spent)} of ${win.limit ? money(win.limit) : "no limit"}`;

/** The first names of a user's servers and how many are left out, e.g. three servers give two names and "+1". */
export function serverSummary(servers: readonly { name: string }[], shown = 2) {
  return { names: servers.slice(0, shown).map((server) => server.name), more: Math.max(0, servers.length - shown) };
}

/** The avatar URL when it is on Discord's CDN, else null (the user's initial is shown instead). */
export const avatarSrc = (url: string | null) => (url?.startsWith(AVATAR_HOST) ? url : null);

/** The pager text: "1–10 of 42", or "0 users" with no users. */
export function pageText(offset: number, shown: number, total: number) {
  return total ? `${offset + 1}–${offset + shown} of ${total}` : "0 users";
}
