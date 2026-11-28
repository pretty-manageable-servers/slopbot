import type { Trigger } from "./types.js";

/** What a wake works on: a sprout, the daily brief, or the home thread. */
export type WakeTarget =
  | { kind: "task"; goal: string; instructions: string; timezone: string }
  | { kind: "brief" | "home"; timezone: string };

/** Local wall-clock time of `ms` in `timezone`: ISO with its offset, and the minute of the day (0-1439). */
export function zonedClock(ms: number, timezone: string): { iso: string; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(ms)
      .map(part => [part.type, part.value]),
  );
  const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  const offset = Math.round((wall - (ms - (((ms % 1000) + 1000) % 1000))) / 60_000);
  const abs = Math.abs(offset);
  const sign = offset < 0 ? "-" : "+";
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    iso: `${new Date(wall).toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
    minute: +parts.hour! * 60 + +parts.minute!,
  };
}

/** The wake message the model reads. Trigger payloads are data, so they are wrapped and cannot close their own wrapper. */
export function wakePrompt(target: WakeTarget, triggers: readonly Trigger[], now: number): string {
  const kinds = [...new Set(triggers.map(trigger => trigger.kind))];
  const lines = target.kind === "task"
    ? [`Goal: ${target.goal}`, `Instructions: ${target.instructions}`]
    : [target.kind === "brief" ? "Daily brief." : "Home thread: answer the messages below."];
  lines.push(`Trigger: ${kinds.length ? kinds.join(", ") : "timer"}`);
  lines.push(`Time: ${zonedClock(now, target.timezone).iso}`);
  lines.push("If there is nothing to do, call assistant_idle.");
  for (const trigger of triggers) {
    // "<" is escaped so no payload can contain the closing tag.
    const json = JSON.stringify(trigger.payload).replace(/</g, "\\u003c");
    lines.push("<untrusted-data>", json, "</untrusted-data>");
  }
  return lines.join("\n");
}
