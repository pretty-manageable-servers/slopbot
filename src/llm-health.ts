import { isOutageError, type LlmDegradedSettings, type LlmHealth, type LlmModeState } from './llm-mode.js';

// Breaker state lives here. The effective mode also follows the admin override, which is read from settings on each call.
// There is no probe. Slopbot never sends its own test request, because a model server may boot on each request and cost money.
// After the cooldown, one real user request is the trial. Its outcome comes back through endTrial.
export class BreakerHealth implements LlmHealth {
  private failures: number[] = [];
  private open = false;
  private lastError: string | undefined;
  // When the next trial may start, and the current cooldown in seconds.
  private retryAt = 0;
  private cooldown = 0;
  // True while one trial request is in flight.
  private trial = false;
  private current: LlmModeState;
  private listeners = new Set<(state: LlmModeState) => void>();

  constructor(
    private settings: () => LlmDegradedSettings,
    private now = Date.now,
  ) {
    this.current = this.snapshot(this.effective(), now());
  }

  state(): LlmModeState {
    return { ...this.sync() };
  }

  recordFailure(code: string): void {
    // Other codes are not outages. Counting them would trip the breaker for the wrong reason.
    // While open, a failure only sets lastError. The trial reports its own outcome through endTrial.
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
        this.cooldown = this.settings().breaker.cooldownSeconds;
        this.retryAt = at + this.cooldown * 1000;
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

  /** True when a trial may start now. It does not claim the slot. */
  trialDue(): boolean {
    return this.canTrial() && !this.trial && this.now() >= this.retryAt;
  }

  /** Claims the one trial slot. False when it is not due or another trial is in flight. */
  claimTrial(): boolean {
    if (!this.trialDue()) return false;
    this.trial = true;
    return true;
  }

  /** Releases the slot. success closes the breaker. outage doubles the cooldown, up to the maximum. other only releases the slot. */
  endTrial(result: 'success' | 'outage' | 'other', code?: string): void {
    if (!this.trial) return;
    this.trial = false;
    if (result === 'success') {
      this.open = false;
      this.failures = [];
      this.cooldown = this.settings().breaker.cooldownSeconds;
      this.lastError = undefined;
    } else if (result === 'outage') {
      const { maxCooldownSeconds } = this.settings().breaker;
      this.cooldown = Math.min(this.cooldown * 2, maxCooldownSeconds);
      this.retryAt = this.now() + this.cooldown * 1000;
      if (code !== undefined) this.lastError = code;
    }
    this.sync();
  }

  // Trials run only while the breaker decides the mode. An admin override takes the mode, so no trial runs.
  private canTrial(): boolean {
    return this.open && this.settings().override === 'auto';
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
}
