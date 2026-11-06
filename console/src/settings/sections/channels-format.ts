// Channels & history: the pure parts of the section, ported from the old console's Channels tab (web/app.js
// historyProgress and drawChannels). No React here, so the rules can be tested without a page.
import type { HistoryState, SnapshotChannel } from "../../api-types";

/** The import progress of a running job. `percent` is null for a job with no bar (an older-messages job). */
export interface HistoryProgress { text: string; percent: number | null }

/** The progress of a running import, or null when no job runs. A window job reports the share of its time window it has reached. */
export function historyProgress(history: HistoryState | undefined): HistoryProgress | null {
  const job = history?.job;
  if (!job) return null;
  const count = `${job.scanned.toLocaleString()} scanned · ${job.added.toLocaleString()} added`;
  if (job.kind !== "window") return { text: `Importing older messages… ${count}`, percent: null };
  const span = job.started - job.cutoff;
  const percent = job.reachedAt == null || span <= 0 ? 0 : Math.max(0, Math.min(100, Math.round(((job.started - job.reachedAt) * 100) / span)));
  return { text: `Importing… ${percent}% · ${count}`, percent };
}

export interface HistoryStatus { label: string; tone: "danger" | "warning" | "muted" }

/** One word for the import: an error wins, then paused, then running, then all history imported, else idle. */
export function historyStatus(history: HistoryState | undefined): HistoryStatus {
  if (history?.error) return { label: `Error: ${history.errorReason || "import failed"}`, tone: "danger" };
  if (history?.paused) return { label: "Paused", tone: "warning" };
  if (history?.job) return { label: "Importing", tone: "muted" };
  if (history?.exhausted) return { label: "All history imported", tone: "muted" };
  return { label: "Idle", tone: "muted" };
}

/** The filter box shows only when there are more than eight channels. */
export const needsChannelFilter = (count: number) => count > 8;

/** Channels whose name contains the filter text (case and outer spaces ignored), monitored first, then by name. */
export function visibleChannels(channels: SnapshotChannel[], filter: string): SnapshotChannel[] {
  const query = filter.trim().toLowerCase();
  return channels
    .filter((channel) => channel.name.toLowerCase().includes(query))
    .sort((a, b) => Number(b.monitored) - Number(a.monitored) || a.name.localeCompare(b.name));
}

/** The history window the bot takes: whole days from 1 to 3650. */
export const isWindowDays = (days: number) => Number.isInteger(days) && days >= 1 && days <= 3650;
