import type { Message } from "./domain.js";
import { logError } from "./errors.js";

/** One event of a live reply run. Text arrives as small deltas, in order. */
export type LiveTextEvent =
  | { kind: "start"; message: Message; runId: string }
  | { kind: "text"; message: Message; runId: string; text: string }
  | { kind: "end"; message: Message; runId: string; status: "done" | "failed" };

type Listener = (event: LiveTextEvent) => void;

/** In-memory feed of reply text while the model streams it. Not saved, not gated by settings. Voice reads it. */
export class LiveText {
  private readonly listeners = new Set<Listener>();
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(event: LiveTextEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { logError("live_text_listener_failed", error, { server: event.message.server }); }
    }
  }
}

export const liveText = new LiveText();
