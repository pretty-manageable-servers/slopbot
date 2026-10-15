import { isOutageError, type LlmDegradedSettings, type LlmHealth, type LlmModeState } from './llm-mode.js';

type Timer = ReturnType<typeof setTimeout>;

// Breaker state lives here. The effective mode also follows the admin override, which is read from settings on each call.
export class BreakerHealth implements LlmHealth {
  private failures: number[] = [];
  private open = false;
  private probeSuccesses = 0;
  private lastError: string | undefined;
  private running = false;
  // One probe chain at a time. A probe in flight blocks a new timer, so stop and start cannot double the probes.
  private probing = false;
  private timer: Timer | undefined;
  private current: LlmModeState;
  private listeners = new Set<(state: LlmModeState) => void>();

  constructor(
    private settings: () => LlmDegradedSettings,
    private probe: () => Promise<boolean>,
    private now = Date.now,
  ) {
    this.current = this.snapshot(this.effective(), now());
  }

  state(): LlmModeState {
    return { ...this.sync() };
  }

  recordFailure(code: string): void {
    // Other codes are not outages. Counting them would trip the breaker for the wrong reason.
    if (!isOutageError(code)) return;
    this.lastError = code;
    if (!this.open) {
      const { breaker } = this.settings();
      const at = this.now();
      this.failures = this.failures.filter(time => at - time <= breaker.windowSeconds * 1000);
      this.failures.push(at);
      if (this.failures.length >= breaker.failures) {
        this.open = true;
        this.failures = [];
        this.probeSuccesses = 0;
        this.schedule();
      }
    }
    this.sync();
  }

  recordSuccess(): void {
    this.sync();
  }

  onChange(listener: (state: LlmModeState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private effective(): Pick<LlmModeState, 'mode' | 'source'> {
    const settings = this.settings();
    if (settings.override !== 'auto') return { mode: settings.override, source: 'override' };
    if (!this.open) return { mode: 'normal', source: 'breaker' };
    // A fallback without a sealed key still counts: a same-gateway fallback reuses the primary key.
    return { mode: settings.fallback ? 'fallback' : 'offline', source: 'breaker' };
  }

  // Updates the state. Listeners run only when the effective mode changes. A settings change is seen on the next call.
  private sync(): LlmModeState {
    const next = this.effective();
    if (next.mode !== this.current.mode) {
      const from = this.current.mode;
      this.current = this.snapshot(next, this.now());
      console.log(JSON.stringify({ type: 'llm_mode_changed', from, to: next.mode, source: next.source, lastError: this.lastError }));
      for (const listener of [...this.listeners]) {
        try { listener({ ...this.current }); } catch { /* one bad listener must not stop the others */ }
      }
    } else {
      this.current = this.snapshot(next, this.current.since);
    }
    return this.current;
  }

  private snapshot(next: Pick<LlmModeState, 'mode' | 'source'>, since: number): LlmModeState {
    return this.lastError === undefined ? { ...next, since } : { ...next, since, lastError: this.lastError };
  }

  private schedule(): void {
    if (!this.running || !this.open || this.timer || this.probing) return;
    this.timer = setTimeout(() => void this.probeOnce(), this.settings().breaker.probeSeconds * 1000);
    this.timer.unref();
  }

  private async probeOnce(): Promise<void> {
    this.timer = undefined;
    this.probing = true;
    let ok = false;
    try { ok = await this.probe(); } catch { ok = false; }
    this.probing = false;
    if (this.open) {
      const { recoverProbes } = this.settings().breaker;
      // A failed probe starts the count again, so recovery needs consecutive good probes.
      this.probeSuccesses = ok ? this.probeSuccesses + 1 : 0;
      if (this.probeSuccesses >= recoverProbes) {
        this.open = false;
        this.failures = [];
        this.probeSuccesses = 0;
        this.lastError = undefined;
      }
    }
    this.sync();
    this.schedule();
  }
}
