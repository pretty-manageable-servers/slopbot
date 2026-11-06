import { EngineEvent, type EngineEnvelope } from "@slopbot/contracts";
import { logError } from "../errors.js";
import { isDirectMessageChannel, isPrivateChannel } from "../private-chat.js";
import { transcriptSwitchOn } from "../server-tools.js";
import type { EngineEventLog } from "./api.js";

type Conversation = EngineEnvelope["conversation"];
type Listener = (envelope: EngineEnvelope) => void;

/** One engine event before the store gives it a sequence number. `turn` is null for message events. */
export interface EngineEventRow {
  server: string;
  channel: string;
  turn: string | null;
  type: EngineEvent["type"];
  data: EngineEvent;
  createdAt: number;
}

/** The store part the event log needs. The switch check reads the same settings as the web transcript. */
export interface EngineEventStore {
  setting(server: string, key: string): unknown;
  taskThreads(server: string): { thread: string; parent: string }[];
  appendEngineEvent(row: EngineEventRow): Promise<number>;
  engineEventsAfter(server: string, channel: string, after: number, limit: number): Promise<EngineEnvelope[]>;
  engineTurnEvents(server: string, channel: string, turn: string): Promise<EngineEvent[]>;
}

const conversationKey = (server: string, channel: string) => JSON.stringify([server, channel]);

/**
 * In-process log of engine events. Each event is checked, saved in publish order with a sequence
 * number, then sent to subscribers. A web chat is always saved; other conversations are saved only
 * while their transcript switch is on.
 */
export class EventLog implements EngineEventLog {
  private store: EngineEventStore | undefined;
  private queue: EngineEventRow[] = [];
  private running = false;
  private current: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<string, Set<Listener>>();
  // Every model token is published, so the switch is read at most once a second per conversation.
  private readonly switches = new Map<string, { on: boolean; until: number }>();

  /** Until a store is attached, publishing does nothing. */
  attach(store: EngineEventStore): void { this.store = store; }

  publish(conversation: Conversation, event: EngineEvent): void {
    const store = this.store;
    if (!store || !this.saves(store, conversation)) return;
    const parsed = EngineEvent.safeParse(event);
    if (!parsed.success) {
      logError("engine_event_invalid", parsed.error, { stage: "engine events", server: conversation.server, channel: conversation.channel }, true);
      return;
    }
    const data = parsed.data;
    this.queue.push({ server: conversation.server, channel: conversation.channel, turn: "turn" in data ? data.turn : null, type: data.type, data, createdAt: Date.now() });
    if (!this.running) {
      this.running = true;
      this.current = this.drain();
    }
  }

  /** Resolves when every event published so far is saved and sent. */
  async idle(): Promise<void> { while (this.running) await this.current; }

  async after(conversation: Conversation, seq: number, limit: number): Promise<EngineEnvelope[]> {
    return this.store ? this.store.engineEventsAfter(conversation.server, conversation.channel, seq, limit) : [];
  }

  async turn(conversation: Conversation, turn: string): Promise<EngineEvent[]> {
    return this.store ? this.store.engineTurnEvents(conversation.server, conversation.channel, turn) : [];
  }

  subscribe(conversation: Conversation, listener: Listener): () => void {
    const id = conversationKey(conversation.server, conversation.channel);
    const set = this.listeners.get(id) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(id); };
  }

  private saves(store: EngineEventStore, conversation: Conversation): boolean {
    if (isPrivateChannel(conversation.channel) && !isDirectMessageChannel(conversation.channel)) return true;
    const id = conversationKey(conversation.server, conversation.channel), now = Date.now(), hit = this.switches.get(id);
    if (hit && hit.until > now) return hit.on;
    const on = transcriptSwitchOn(store, conversation.server, conversation.channel);
    this.switches.set(id, { on, until: now + 1000 });
    return on;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const store = this.store;
      for (const row of this.queue.splice(0)) {
        if (!store) break;
        let seq: number;
        try { seq = await store.appendEngineEvent(row); }
        catch (error) { logError("engine_events_save_failed", error, { stage: "engine events", server: row.server, channel: row.channel }, true); continue; }
        const envelope: EngineEnvelope = { seq, at: row.createdAt, conversation: { server: row.server, channel: row.channel }, event: row.data };
        for (const listener of this.listeners.get(conversationKey(row.server, row.channel)) ?? []) {
          try { listener(envelope); } catch (error) { logError("engine_events_listener_failed", error, { server: row.server, channel: row.channel }); }
        }
      }
    }
    this.running = false;
  }
}

/** The process-wide event log. The Discord adapter attaches the store once. */
export const engineEvents = new EventLog();
