import { randomUUID } from "node:crypto";
import type { ChannelAccess } from "./channel-access.js";
import { ToolError } from "./tools.js";

/** One summary in a member's inbox. */
export interface InboxItem {
  id: string; server: string; target: string; sender: string;
  /** The channel of the source messages. */
  channel: string;
  /** Discord message IDs that the summary covers. */
  sourceIds: string[];
  /** 1 to INBOX_MAX_SUMMARY characters, plain text. */
  summary: string;
  created_at: number; done_at: number | null;
}
export const INBOX_MAX_SUMMARY = 1000;
export const INBOX_SENDER_DAILY_LIMIT = 20;
export const INBOX_TTL_MS = 30 * 24 * 60 * 60_000;

/** Rows in inbox_items. Both SQLite and PostgreSQL implement it. */
export interface InboxStore {
  addInboxItem(item: InboxItem): Promise<void>;
  /** Newest first. */
  inboxItems(server: string, target: string, options: { includeDone: boolean; limit: number }): Promise<InboxItem[]>;
  /** Changes only open items of this target. Returns the count changed. */
  markInboxDone(server: string, target: string, ids: string[] | "all", at: number): Promise<number>;
  countInboxSent(server: string, sender: string, since: number): Promise<number>;
  /** Deletes open and done items created before `before`. */
  deleteExpiredInbox(before: number): Promise<number>;
}

const DAY_MS = 24 * 60 * 60_000;
const INBOX_LIST_LIMIT = 50;
const INBOX_MAX_SOURCE_IDS = 50;

/** Member inboxes for one server: add a summary, list open items, mark them done. */
export class Inbox {
  constructor(private readonly store: InboxStore, private readonly access: ChannelAccess, private readonly now: () => number = Date.now) {}
  async add(input: { server: string; target: string; sender: string; channel: string; sourceIds: string[]; summary: string }): Promise<InboxItem> {
    const summary = input.summary.trim();
    if (!summary) throw new ToolError("Summary cannot be empty.");
    if (summary.length > INBOX_MAX_SUMMARY) throw new ToolError(`Summary is too long. Use at most ${INBOX_MAX_SUMMARY} characters.`);
    if (input.sourceIds.length < 1 || input.sourceIds.length > INBOX_MAX_SOURCE_IDS) throw new ToolError(`Give 1 to ${INBOX_MAX_SOURCE_IDS} source message IDs.`);
    const now = this.now();
    if (await this.store.countInboxSent(input.server, input.sender, now - DAY_MS) >= INBOX_SENDER_DAILY_LIMIT) throw new ToolError(`You can add ${INBOX_SENDER_DAILY_LIMIT} inbox items a day.`);
    if (!(await this.access.check(input.server, input.channel, input.target)).view) throw new ToolError("That member cannot see this channel.");
    const item: InboxItem = {
      id: randomUUID(), server: input.server, target: input.target, sender: input.sender, channel: input.channel,
      sourceIds: [...input.sourceIds], summary, created_at: now, done_at: null,
    };
    await this.store.addInboxItem(item);
    return item;
  }
  /** Open items by default. Items in channels the user cannot view now are left out. */
  async list(server: string, user: string, includeDone = false): Promise<InboxItem[]> {
    const items = await this.store.inboxItems(server, user, { includeDone, limit: INBOX_LIST_LIMIT });
    const visible = await Promise.all(items.map(async item => (await this.access.check(server, item.channel, user)).view));
    return items.filter((_item, index) => visible[index]);
  }
  done(server: string, user: string, ids: string[] | "all"): Promise<number> {
    return this.store.markInboxDone(server, user, ids, this.now());
  }
}
