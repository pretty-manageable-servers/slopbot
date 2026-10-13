import { errorSummary, logError } from "./errors.js";
import type { Json, Message } from "./domain.js";

export interface HistoryState {
  days: number;
  syncedThrough: number;
  exhausted: boolean;
  paused: boolean;
  oldest: { id: string; timestamp: number } | null;
  job: null | { kind: "window" | "more"; before: string | null; cutoff: number; started: number; remaining: number | null; scanned: number; added: number; reachedAt: number | null };
  error: boolean;
  errorReason?: string;
}

export interface HistoryStore {
  setting(server: string, key: string): unknown;
  setSetting(server: string, key: string, value: Json): void | Promise<void>;
  ingest(message: Message): Promise<boolean>;
  finishIndexing(): Promise<void>;
  /** Deletes the saved messages of one channel older than cutoff. Returns the oldest message left, or null. */
  purgeChannelBefore(server: string, channel: string, cutoff: number): Promise<{ id: string; timestamp: number } | null>;
}
export interface HistorySource {
  // Return newest first, strictly before the cursor, up to limit messages.
  fetch(channel: string, before: string | null, limit: number): Promise<readonly Message[]>;
}

// Cursors are saved after ingestion. Replaying an interrupted page is safe.
export class HistoryImporter {
  private readonly workers = new Map<string, Promise<void>>();
  private stopping = false;
  private readonly excluded = new Set<string>();
  constructor(private readonly server: string, private readonly store: HistoryStore, private readonly source: HistorySource,
    private readonly defaultDays = 7, private readonly now = Date.now) {}

  state(channel: string): HistoryState {
    return this.store.setting(this.server, `history:${channel}`) as HistoryState | undefined ?? {
      days: this.defaultDays, syncedThrough: 0, exhausted: false, paused: false, oldest: null, job: null, error: false,
    };
  }
  private async save(channel: string, state: HistoryState): Promise<void> {
    await this.store.setSetting(this.server, `history:${channel}`, state as unknown as Json);
  }
  async start(channel: string, action: "window" | "more" | "resume" = "resume", days?: number): Promise<void> {
    if (this.stopping || this.excluded.has(channel) || this.workers.has(channel)) return;
    const state = this.state(channel);
    if (action !== "resume") state.paused = false;
    if (state.paused) return;
    if (days !== undefined) {
      if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error("Window must be 1 to 3650 days");
      if (state.days !== days) state.syncedThrough = 0;
      // A shorter window deletes the saved messages it no longer covers. A longer window deletes nothing.
      if (days < state.days) state.oldest = await this.store.purgeChannelBefore(this.server, channel, this.now() - days * 86400000);
      state.days = days;
    }
    if (!state.job) {
      if (action === "more" && state.exhausted) return;
      const started = this.now();
      state.job = {
        kind: action === "more" ? "more" : "window",
        before: action === "more" ? (state.oldest?.id ?? null) : null,
        cutoff: action === "more" ? 0 : (state.syncedThrough || started - state.days * 86400000),
        started, remaining: action === "more" ? 5000 : null, scanned: 0, added: 0, reachedAt: null,
      };
    }
    state.error = false;
    delete state.errorReason;
    const saved = this.save(channel, state);
    const worker = saved.then(() => this.run(channel)).catch(async error => {
      logError("history_import_failed", error, { stage: "history import", server: this.server, channel });
      const current = this.state(channel); current.error = true; current.errorReason = errorSummary(error); await this.save(channel, current);
    }).finally(() => this.workers.delete(channel));
    this.workers.set(channel, worker);
    await saved;
  }
  async exclude(channel: string): Promise<void> { this.excluded.add(channel); await this.pause(channel); }
  async include(channel: string): Promise<void> { this.excluded.delete(channel); await this.resume(channel); }
  busy(channel: string): boolean { return this.workers.has(channel); }
  async pause(channel: string): Promise<void> {
    const state = this.state(channel); state.paused = true; await this.save(channel, state);
  }
  async resume(channel: string): Promise<void> {
    const state = this.state(channel); state.paused = false; await this.save(channel, state); await this.start(channel);
  }
  async idle(): Promise<void> { await Promise.all([...this.workers.values()]); }
  async stop(): Promise<void> { this.stopping = true; await this.idle(); }

  private async run(channel: string): Promise<void> {
    while (!this.stopping) {
      const state = this.state(channel), job = state.job;
      if (state.paused || !job) return;
      const limit = Math.min(100, job.remaining ?? 100);
      const page = await this.source.fetch(channel, job.before, limit);
      if (this.excluded.has(channel) || this.state(channel).paused) return;
      let reachedCutoff = false;
      for (const message of page) {
        if (message.server !== this.server || message.channel !== channel || message.timestamp === undefined) throw new Error("Invalid history source");
        if (job.kind === "window" && message.timestamp < job.cutoff) { reachedCutoff = true; break; }
        if (await this.store.ingest(message)) job.added++;
        job.scanned++;
        // The oldest timestamp this job has reached. The console uses it for the progress bar.
        job.reachedAt = job.reachedAt === null ? message.timestamp : Math.min(job.reachedAt, message.timestamp);
        if (!state.oldest || message.timestamp < state.oldest.timestamp || (message.timestamp === state.oldest.timestamp && (message.id.length < state.oldest.id.length || (message.id.length === state.oldest.id.length && message.id < state.oldest.id)))) state.oldest = { id: message.id, timestamp: message.timestamp };
      }
      const exhausted = page.length < limit && !reachedCutoff;
      if (exhausted) state.exhausted = true;
      if (job.remaining !== null) job.remaining -= page.length;
      const finished = reachedCutoff || exhausted || job.remaining === 0;
      if (finished) {
        if (job.kind === "window") state.syncedThrough = job.started;
        state.job = null;
      } else {
        const cursor = page.at(-1)!.id;
        if (cursor === job.before) throw new Error("History cursor did not advance");
        job.before = cursor;
      }
      // Respect a pause that arrived while fetching the page.
      state.paused = this.state(channel).paused;
      await this.save(channel, state);
      await this.store.finishIndexing();
      if (finished) return;
    }
  }
}
