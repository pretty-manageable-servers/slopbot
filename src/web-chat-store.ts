// Works for both the SQLite handle (synchronous) and the Postgres wrapper (async).
// Queries use `?` placeholders and json_extract, which the Postgres wrapper translates.
export interface ChatDb {
  prepare(sql: string): { all(...values: any[]): any; get(...values: any[]): any; run(...values: any[]): any };
}

import { parseEffort, type Effort } from "./domain.js";

/** One private chat. `channel` is `web:<id>`. */
export interface WebChatRow { id: string; server: string; owner: string; title: string; created: number; updated: number; deleted: boolean; effort?: Effort }

const COLUMNS = "id,server,owner,title,created,updated,deleted,effort";

function chatOf(row: Record<string, unknown>): WebChatRow {
  return { id: String(row.id), server: String(row.server), owner: String(row.owner), title: String(row.title), created: Number(row.created), updated: Number(row.updated), deleted: Number(row.deleted) === 1, ...(parseEffort(row.effort) ? { effort: parseEffort(row.effort)! } : {}) };
}

export async function insertWebChat(db: ChatDb, row: WebChatRow): Promise<void> {
  await db.prepare("INSERT INTO web_chats(id,server,owner,title,created,updated,deleted) VALUES(?,?,?,?,?,?,?)")
    .run(row.id, row.server, row.owner, row.title, row.created, row.updated, row.deleted ? 1 : 0);
}

/** A chat that was deleted is still returned here, with deleted set, so callers can refuse it. */
export async function getWebChat(db: ChatDb, id: string): Promise<WebChatRow | undefined> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM web_chats WHERE id=?`).get(id);
  return row ? chatOf(row) : undefined;
}

/** Live chats of one owner in one server, newest first. */
export async function listWebChats(db: ChatDb, server: string, owner: string): Promise<WebChatRow[]> {
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM web_chats WHERE server=? AND owner=? AND deleted=0 ORDER BY updated DESC, id`).all(server, owner);
  return rows.map(chatOf);
}

/** Channels of every live chat in a server. Used at startup to reopen them. */
export async function liveWebChatChannels(db: ChatDb, server: string): Promise<string[]> {
  const rows = await db.prepare("SELECT id FROM web_chats WHERE server=? AND deleted=0").all(server);
  return rows.map((row: Record<string, unknown>) => `web:${String(row.id)}`);
}

export async function renameWebChat(db: ChatDb, id: string, title: string, updated: number): Promise<void> {
  await db.prepare("UPDATE web_chats SET title=?, updated=? WHERE id=?").run(title, updated, id);
}

export async function touchWebChat(db: ChatDb, id: string, updated: number): Promise<void> {
  await db.prepare("UPDATE web_chats SET updated=? WHERE id=? AND deleted=0").run(updated, id);
}

export async function setWebChatEffort(db: ChatDb, id: string, effort: Effort | null): Promise<void> {
  await db.prepare("UPDATE web_chats SET effort=? WHERE id=? AND deleted=0").run(effort, id);
}

/** Marks a chat deleted. The caller removes its messages, runs and events (see deleteChatRows). */
export async function markWebChatDeleted(db: ChatDb, id: string, updated: number): Promise<void> {
  await db.prepare("UPDATE web_chats SET deleted=1, title='', updated=? WHERE id=?").run(updated, id);
}

/**
 * Removes the stored runs, events and queue rows of one channel. Messages are removed by the store
 * itself, which also invalidates memories and context. Call this before the messages go, because
 * some deletes read them.
 */
export async function deleteChatRows(db: ChatDb, server: string, channel: string): Promise<void> {
  const runs = "SELECT id FROM runs WHERE json_extract(message,'$.server')=? AND json_extract(message,'$.channel')=?";
  const messages = "SELECT id FROM messages WHERE server=? AND channel=?";
  await db.prepare(`DELETE FROM events WHERE run_id IN (${runs})`).run(server, channel);
  await db.prepare(`DELETE FROM run_sources WHERE run_id IN (${runs})`).run(server, channel);
  await db.prepare(`DELETE FROM reply_runs WHERE server=? AND run_id IN (${runs})`).run(server, server, channel);
  await db.prepare(`DELETE FROM agent_turns WHERE server=? AND (message_id IN (${messages}) OR message_id IN (SELECT json_extract(message,'$.id') FROM runs WHERE json_extract(message,'$.server')=? AND json_extract(message,'$.channel')=?))`).run(server, server, channel, server, channel);
  await db.prepare(`DELETE FROM harness_events WHERE server=? AND message_id IN (${messages})`).run(server, server, channel);
  await db.prepare("DELETE FROM runs WHERE json_extract(message,'$.server')=? AND json_extract(message,'$.channel')=?").run(server, channel);
  await db.prepare("DELETE FROM jobs WHERE server=? AND channel=?").run(server, channel);
  await db.prepare("DELETE FROM tool_operations WHERE server=? AND channel=?").run(server, channel);
  await db.prepare("DELETE FROM deliveries WHERE json_extract(message,'$.server')=? AND json_extract(message,'$.channel')=?").run(server, channel);
  await db.prepare("DELETE FROM conversation_events WHERE server=? AND channel=?").run(server, channel);
}
