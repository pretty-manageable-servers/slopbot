// The Usage rules as pure functions: the window names, the reset label and the bar level. The old console had them
// in web/conversations.js (usageLevel, resetsLabel). Kept apart from the section so they test without the DOM.

/** "5-hour" for the 5-hour window, "Weekly" for the week, else the kind as the bot sent it. */
export function windowName(kind: string): string {
  return kind === "5h" ? "5-hour" : kind === "week" ? "Weekly" : kind;
}

/** Time to a reset with two units: "Resets in 3d 4h" over a day, else "Resets in 2h 15m". `resetAt` is in ms. */
export function resetsLabel(resetAt: number, now: number = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((resetAt - now) / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  return `Resets in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${rest}m`}`;
}

/** The bar color of a percent: accent below 50, warning from 50, danger from 80. */
export type UsageLevel = "low" | "mid" | "high";
export function usageLevel(percent: number): UsageLevel {
  return percent >= 80 ? "high" : percent >= 50 ? "mid" : "low";
}
