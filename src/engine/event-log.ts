import { EngineEvent, type EngineEnvelope } from "@slopbot/contracts";
import { logError } from "../errors.js";
import { isDirectMessageChannel, isPrivateChannel } from "../private-chat.js";
import { transcriptSwitchOn } from "../server-tools.js";
import type { EngineEventLog } from "./api.js";

type Conversation = EngineEnvelope["conversation"];
type Listener = (envelope: EngineEnvelope) => void;
type Delta = Extract<EngineEvent, { text: string }>;

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

/** An event waiting to be saved and sent. `save` is false for a conversation whose switch is off. */
interface Pending { server: string; channel: string; event: EngineEvent; createdAt: number; save: boolean }

const conversationKey = (server: string, channel: string) => JSON.stringify([server, channel]);

/** Consecutive text or thinking deltas of one run, and consecutive tool input of one call, join. */
function joins(last: EngineEvent, next: EngineEvent): boolean {
  if (last.type === "tool.input") return next.type === "tool.input" && next.turn === last.turn && next.call === last.call;
  if (last.type === "text.delta" || last.type === "thinking.delta") {
    return (next.type === "text.delta" || next.type === "thinking.delta") && next.type === last.type && next.turn === last.turn && next.run === last.run;
  }
  return false;
}

/** Splits a batch into groups. Each group is saved as one row. Events of a group that is not saved stay alone. */
function groupRows(items: Pending[]): Pending[][] {
  const groups: Pending[][] = [];
  for (const item of items) {
    const group = groups.at(-1), last = group?.at(-1);
    if (group && last && item.save && last.save && last.server === item.server && last.channel === item.channel && joins(last.event, item.event)) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

/** The row a group saves: its first delta with the text of every delta in the group. */
function rowEvent(group: Pending[]): EngineEvent {
  const head = group[0]!.event;
  if (group.length === 1) return head;
  return { ...head, text: group.map(item => (item.event as Delta).text).join("") } as EngineEvent;
}

/**
 * In-process log of engine events. Each event is checked, then sent to subscribers in publish
 * order. A web chat is always saved; other conversations are saved only while their transcript
 * switch is on. A saved event carries its seq. An event that is not saved is sent without one.
 * Consecutive deltas are saved as one row, but each delta is sent as it was published.
 */
export class EventLog implements EngineEventLog {
  private store: EngineEventStore | undefined;
  private queue: Pending[] = [];
  private running = false;
  private current: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<string, Set<Listener>>();
  // Every model token is published, so the switch is read at most once a second per conversation.
  private readonly switches = new Map<string, { on: boolean; until: number }>();

  /** Until a store is attached, publishing does nothing. */
  attach(store: EngineEventStore): void { this.store = store; }

  publish(conversation: Conversation, event: EngineEvent): void {
    const store = this.store;
    if (!store) return;
    const parsed = EngineEvent.safeParse(event);
    if (!parsed.success) {
      logError("engine_event_invalid", parsed.error, { stage: "engine events", server: conversation.server, channel: conversation.channel }, true);
      return;
    }
    this.queue.push({ server: conversation.server, channel: conversation.channel, event: parsed.data, createdAt: Date.now(), save: this.saves(store, conversation) });
    // The drain starts after the current tick, so events published together form one batch and their deltas join.
    if (!this.running) {
      this.running = true;
      this.current = Promise.resolve().then(() => this.drain());
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
      for (const group of groupRows(this.queue.splice(0))) {
        if (!store) break;
        const head = group[0]!;
        let seq: number | undefined;
        if (head.save) {
          const event = rowEvent(group);
          try { seq = await store.appendEngineEvent({ server: head.server, channel: head.channel, turn: "turn" in event ? event.turn : null, type: event.type, data: event, createdAt: head.createdAt }); }
          catch (error) { logError("engine_events_save_failed", error, { stage: "engine events", server: head.server, channel: head.channel }, true); continue; }
        }
        for (const item of group) {
          const envelope: EngineEnvelope = { ...(seq === undefined ? {} : { seq }), at: item.createdAt, conversation: { server: item.server, channel: item.channel }, event: item.event };
          for (const listener of this.listeners.get(conversationKey(item.server, item.channel)) ?? []) {
            try { listener(envelope); } catch (error) { logError("engine_events_listener_failed", error, { server: item.server, channel: item.channel }); }
          }
        }
      }
    }
    this.running = false;
  }
}

/** The process-wide event log. The Discord adapter attaches the store once. */
export const engineEvents = new EventLog();
