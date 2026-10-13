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
