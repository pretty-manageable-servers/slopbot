import { describe, expect, test } from "vitest";
import type { HistoryState, SnapshotChannel } from "../../api-types";
import { historyProgress, historyStatus, isWindowDays, needsChannelFilter, visibleChannels } from "./channels-format";

const history = (overrides: Partial<HistoryState> = {}): HistoryState => ({
  days: 30, syncedThrough: 0, exhausted: false, paused: false, oldest: null, job: null, error: false, ...overrides,
});
const windowJob = { kind: "window" as const, before: null, cutoff: 0, started: 100, remaining: null, scanned: 40, added: 7, reachedAt: 50 };
const moreJob = { kind: "more" as const, before: "m9", cutoff: 0, started: 100, remaining: null, scanned: 12, added: 3, reachedAt: null };

describe("historyProgress", () => {
  test("a window job shows the share of its window it has reached", () => {
    expect(historyProgress(history({ job: windowJob }))).toEqual({ text: "Importing… 50% · 40 scanned · 7 added", percent: 50 });
  });

  test("a window job that has not reached its window yet shows 0%", () => {
    expect(historyProgress(history({ job: { ...windowJob, reachedAt: null } }))?.percent).toBe(0);
  });

  test("an older-messages job shows a count and no bar", () => {
    expect(historyProgress(history({ job: moreJob }))).toEqual({ text: "Importing older messages… 12 scanned · 3 added", percent: null });
  });

  test("no job shows nothing", () => {
    expect(historyProgress(history())).toBeNull();
    expect(historyProgress(undefined)).toBeNull();
  });
});

describe("historyStatus", () => {
  test("a running job reads Importing", () => {
    expect(historyStatus(history({ job: windowJob }))).toEqual({ label: "Importing", tone: "muted" });
  });

  test("a paused import reads Paused", () => {
    expect(historyStatus(history({ paused: true }))).toEqual({ label: "Paused", tone: "warning" });
  });

  test("an error shows its reason, and wins over paused", () => {
    expect(historyStatus(history({ error: true, errorReason: "Discord 403", paused: true }))).toEqual({ label: "Error: Discord 403", tone: "danger" });
    expect(historyStatus(history({ error: true }))).toEqual({ label: "Error: import failed", tone: "danger" });
  });

  test("a channel with all its history imported reads so", () => {
    expect(historyStatus(history({ exhausted: true }))).toEqual({ label: "All history imported", tone: "muted" });
  });

  test("otherwise the import is idle", () => {
    expect(historyStatus(history())).toEqual({ label: "Idle", tone: "muted" });
  });
});

describe("channel filter", () => {
  const channel = (name: string, monitored = false): SnapshotChannel => ({ id: `id-${name}`, name, monitored });
  const channels = [channel("general"), channel("Ops", true), channel("random"), channel("garden", true)];

  test("matches names case-insensitively, ignoring outer spaces", () => {
    expect(visibleChannels(channels, "  OP ").map((c) => c.name)).toEqual(["Ops"]);
    expect(visibleChannels(channels, "ar").map((c) => c.name)).toEqual(["garden"]);
  });

  test("an empty filter keeps every channel, monitored first and then by name", () => {
    expect(visibleChannels(channels, "").map((c) => c.name)).toEqual(["garden", "Ops", "general", "random"]);
  });

  test("the filter box shows only above eight channels", () => {
    expect(needsChannelFilter(8)).toBe(false);
    expect(needsChannelFilter(9)).toBe(true);
  });
});

describe("isWindowDays", () => {
  test("accepts whole days from 1 to 3650", () => {
    expect([1, 3650].map(isWindowDays)).toEqual([true, true]);
    expect([0, 3651, 2.5, Number.NaN].map(isWindowDays)).toEqual([false, false, false, false]);
  });
});
