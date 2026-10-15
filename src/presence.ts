import { logError } from "./errors.js";
import type { LlmMode } from "./llm-mode.js";

export const PRESENCE_INTERVAL_MS = 5 * 60_000;
export const PRESENCE_TEXT_LIMIT = 128;

export interface PresenceOptions {
  setStatus: (text: string) => void;
  countReplies: (since: number) => Promise<number>;
  guildCount: () => number;
  now?: () => number;
  intervalMs?: number;
  mode?: () => LlmMode;
}

/** The first millisecond of the UTC day that contains `at`. */
export function utcMidnight(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** The custom status text, for example "3 replies today · 1 server". A reduced mode shows "Reduced capacity" instead of the count. */
export function presenceText(replies: number, servers: number, reduced = false): string {
  const count = reduced ? "Reduced capacity" : `${replies} ${replies === 1 ? "reply" : "replies"} today`;
  const text = `${count} · ${servers} ${servers === 1 ? "server" : "servers"}`;
  return text.slice(0, PRESENCE_TEXT_LIMIT);
}

/** Keeps the bot's custom status up to date. It sends a status only when the text changes. */
export class PresenceUpdater {
  private readonly setStatus: (text: string) => void;
  private readonly countReplies: (since: number) => Promise<number>;
  private readonly guildCount: () => number;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly mode: () => LlmMode;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private busy = false;
  private text: string | undefined;

  constructor(options: PresenceOptions) {
    this.setStatus = options.setStatus;
    this.countReplies = options.countReplies;
    this.guildCount = options.guildCount;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? PRESENCE_INTERVAL_MS;
    this.mode = options.mode ?? (() => "normal");
  }

  /** Refreshes now, then every intervalMs. The timer does not keep the process alive. */
  start(): void {
    if (this.timer || this.stopped) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads the counts and sends the text if it changed. A failed count keeps the last text. */
  async refresh(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      let replies: number;
      try {
        replies = await this.countReplies(utcMidnight(this.now()));
      } catch (error) {
        logError("presence_count_failed", error, { stage: "presence" }, true);
        return;
      }
      if (this.stopped) return;
      const text = presenceText(replies, this.guildCount(), this.mode() !== "normal");
      if (text === this.text) return;
      try {
        this.setStatus(text);
        this.text = text;
      } catch (error) {
        logError("presence_update_failed", error, { stage: "presence" }, true);
      }
    } finally {
      this.busy = false;
    }
  }
}
