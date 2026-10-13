import type { Message } from "./domain.js";

/** A source that a later run used can join two replies only when the later trigger came this soon after the reply. A reply to a reply has no limit. */
export const SOURCE_CHAIN_MS = 10 * 60 * 1000;
export const TITLE_CHARS = 60;

/** A reply run of one channel, with the trigger message it answered. */
export interface ChannelRun { id: string; message: Message; status: string }
/** A Slopbot reply message of one channel, and a reply run that wrote it. */
export interface ChannelReply { messageId: string; runId: string; timestamp: number | null }
/** A message that a run used as a source. Only messages that still exist in the channel are listed. */
export interface RunSource { runId: string; messageId: string }

/** One conversation: reply runs that continue each other, with their trigger, sources and replies. */
export interface ConversationGroup {
  /** The ID of the first run. It is the conversation ID in URLs. */
  id: string;
  runIds: string[];
  /** Triggers, sources and replies. A trigger that was deleted still counts. */
  messageIds: string[];
  trigger: Message;
  title: string;
  start: number;
  end: number;
  messageCount: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  author: string;
  authorName: string;
  start: number;
  end: number;
  messageCount: number;
}

/** The title is the trigger text, on one line and cut to TITLE_CHARS characters. */
export function conversationTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "(no text)";
  const chars = Array.from(flat);
  return chars.length > TITLE_CHARS ? chars.slice(0, TITLE_CHARS - 1).join("") + "…" : flat;
}

/**
 * Groups the reply runs of one channel into conversations. Rules, applied as links between runs:
 * 1. Runs with the same trigger message are one request (tool rounds), so they always join.
 * 2. A trigger whose replyTo is a Slopbot reply, or the trigger of another request, joins that run.
 * 3. A run that used a Slopbot reply as a source joins that reply's run, when the trigger came within SOURCE_CHAIN_MS of the reply.
 * Human messages used as sources never link runs, so a busy channel does not become one conversation.
 * Runs must be given oldest first. Returns conversations newest first.
 */
export function groupConversations(runs: readonly ChannelRun[], replies: readonly ChannelReply[], sources: readonly RunSource[]): ConversationGroup[] {
  const parent = new Map<string, string>(runs.map(run => [run.id, run.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a) || !parent.has(b)) return;
    const x = find(a), y = find(b);
    if (x !== y) parent.set(y, x);
  };
  const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
    const list = map.get(key);
    if (list) list.push(value); else map.set(key, [value]);
  };

  const byId = new Map(runs.map(run => [run.id, run]));
  const requestRun = new Map<string, string>();
  for (const run of runs) {
    const first = requestRun.get(run.message.id);
    if (first) union(run.id, first); else requestRun.set(run.message.id, run.id);
  }
  const replyRuns = new Map<string, string[]>();
  const repliesByRun = new Map<string, ChannelReply[]>();
  for (const reply of replies) {
    push(replyRuns, reply.messageId, reply.runId);
    push(repliesByRun, reply.runId, reply);
  }
  const usedBy = new Map<string, string[]>();
  for (const source of sources) push(usedBy, source.runId, source.messageId);
  const replyAt = new Map<string, number | null>(replies.map(reply => [reply.messageId, reply.timestamp]));

  for (const run of runs) {
    const replyTo = run.message.replyTo;
    if (replyTo) {
      for (const other of replyRuns.get(replyTo) ?? []) union(run.id, other);
      const trigger = requestRun.get(replyTo);
      if (trigger) union(run.id, trigger);
    }
    // Context almost always holds recent Slopbot replies, so only the newest one can link, and only for the same person.
    let newest: string | undefined, newestAt = -Infinity;
    for (const messageId of usedBy.get(run.id) ?? []) {
      const at = replyAt.get(messageId);
      if (!replyRuns.has(messageId) || at === null || at === undefined || at <= newestAt) continue;
      newest = messageId; newestAt = at;
    }
    const asked = run.message.timestamp;
    if (newest && asked !== undefined && asked - newestAt <= SOURCE_CHAIN_MS) {
      for (const other of replyRuns.get(newest)!) if (byId.get(other)?.message.author === run.message.author) union(run.id, other);
    }
  }

  const members = new Map<string, ChannelRun[]>();
  for (const run of runs) push(members, find(run.id), run);
  const groups: ConversationGroup[] = [];
  for (const group of members.values()) {
    const first = group[0]!;
    const ids = new Set<string>();
    let start: number | undefined, end = 0;
    for (const run of group) {
      ids.add(run.message.id);
      for (const messageId of usedBy.get(run.id) ?? []) ids.add(messageId);
      for (const reply of repliesByRun.get(run.id) ?? []) {
        ids.add(reply.messageId);
        if (reply.timestamp !== null && reply.timestamp > end) end = reply.timestamp;
      }
      const at = run.message.timestamp ?? 0;
      if (start === undefined || at < start) start = at;
      if (at > end) end = at;
    }
    groups.push({
      id: first.id,
      runIds: group.map(run => run.id),
      messageIds: [...ids],
      trigger: first.message,
      title: conversationTitle(first.message.text ?? ""),
      start: start ?? 0,
      end,
      messageCount: ids.size,
    });
  }
  return groups.sort((a, b) => b.end - a.end || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export function conversationSummary(group: ConversationGroup): ConversationSummary {
  return {
    id: group.id,
    title: group.title,
    author: group.trigger.author,
    authorName: group.trigger.authorName ?? group.trigger.author,
    start: group.start,
    end: group.end,
    messageCount: group.messageCount,
  };
}
