import type { Message } from './domain.js';
import { logError, errorSummary } from './errors.js';
import { createHash } from 'node:crypto';
import { diagnosticText, type FixWatch, type Operations } from './operations.js';

/** Durable notification intent + existing Discord delivery journal handle restart recovery. */
export class FixWatchWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  constructor(private readonly server: string, private readonly operations: Operations,
    private readonly authorize: (message: Message) => Promise<void>,
    private readonly deliver: (message: Message, text: string, id: string) => Promise<void>) {}
  start() {
    if (this.timer) return;
    const tick = () => {
      if (this.active) return;
      this.active = this.tick().catch(error => logError('fix_watch_failed', error, { server: this.server }, true)).finally(() => { this.active = undefined; });
    };
    tick(); this.timer = setInterval(tick, 60000); this.timer.unref();
  }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.active; }
  async tick() {
    const { store } = this.operations.services;
    for (const record of await store.records(this.server, 'fix_watch')) {
      let watch = record.value as unknown as FixWatch;
      if (!watch.active) continue;
      const message: Message = { server: this.server, channel: watch.channel, author: watch.owner, id: `fix-watch:${record.id}`, text: `Follow issue #${watch.issue}` };
      try {
        await this.authorize(message);
        let revision = record.revision;
        if (!watch.pending) {
          let snapshot;
          try { snapshot = await this.operations.fixSnapshot(watch.issue, watch.pull); }
          catch (error) { snapshot = { unavailable: 'Fix tracking lookup failed', error: errorSummary(error) }; }
          if (JSON.stringify(snapshot) === JSON.stringify(watch.snapshot)) continue;
          const id = createHash('sha256').update(`${this.server}:${record.id}:${revision}:${JSON.stringify(snapshot)}`).digest('hex').slice(0, 32);
          watch = { ...watch, pending: { id: `fix-watch:${id}`, snapshot,
            text: diagnosticText(`Issue #${watch.issue} tracking changed.\nAcceptance check: ${watch.acceptance}\n${JSON.stringify(snapshot, null, 2)}\nUse fix_watch status to investigate; collect a fresh interaction before recording behavioral verification.`, 10000) } };
          if (!await store.putRecord(this.server, 'fix_watch', record.id, JSON.parse(JSON.stringify(watch)), revision)) continue;
          revision++;
        }
        // Cancellation or ownership changes must take effect before sending a pending notification.
        const current = await store.record(this.server, 'fix_watch', record.id);
        if (!current || current.revision !== revision || !(current.value as unknown as FixWatch).active) continue;
        await this.authorize(message);
        await this.deliver(message, watch.pending!.text, watch.pending!.id);
        const next = { ...watch, snapshot: watch.pending!.snapshot }; delete next.pending;
        await store.putRecord(this.server, 'fix_watch', record.id, JSON.parse(JSON.stringify(next)), revision);
      } catch (error) {
        logError('fix_watch_poll_failed', error, { server: this.server, channel: watch.channel }, true);
      }
    }
  }
}
