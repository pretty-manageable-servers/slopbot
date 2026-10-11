import type { Message, ModelEvent } from "./domain.js";
import type { Store } from "./ports.js";
import { requestTimings } from "./request-timing.js";

// Preserve original payloads/order. Batch bounded writes; flush even on stream failure.
export class EventJournal {
  private pending: ModelEvent[] = [];
  private bytes = 0;
  private sequence = 0;
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly store: Pick<Store, "appendEvent" | "appendEvents">,
    private readonly runId: string,
    private readonly message: Message,
    private readonly phase: string,
  ) {
    this.timer = setInterval(() => {
      void this.flush().catch((error) => {
        this.failure = error;
      });
    }, 250);
    this.timer.unref();
  }
  async append(event: ModelEvent): Promise<void> {
    if (this.failure) throw this.failure;
    this.pending.push(event);
    this.bytes += Buffer.byteLength(JSON.stringify(event));
    if (this.pending.length >= 32 || this.bytes >= 65536) await this.flush();
  }
  private flush(): Promise<void> {
    if (!this.pending.length) return this.tail;
    const batch = this.pending;
    const sequence = this.sequence;
    this.pending = [];
    this.bytes = 0;
    this.sequence += batch.length;
    this.tail = this.tail.then(() =>
      requestTimings.measure(
        this.message,
        `${this.phase} journal`,
        async () => {
          if (this.store.appendEvents)
            await this.store.appendEvents(this.runId, sequence, batch);
          else
            for (let index = 0; index < batch.length; index++)
              await this.store.appendEvent(
                this.runId,
                sequence + index,
                batch[index]!,
              );
        },
      ),
    );
    return this.tail;
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    await requestTimings.wait("journal durability", () => this.flush());
    if (this.failure) throw this.failure;
  }
}
