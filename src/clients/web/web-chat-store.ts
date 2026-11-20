// Works for both the SQLite handle (synchronous) and the Postgres wrapper (async).
// Queries use `?` placeholders and json_extract, which the Postgres wrapper translates.
export interface ChatDb {
  prepare(sql: string): { all(...values: any[]): any; get(...values: any[]): any; run(...values: any[]): any };
}

import { parseEffort, type Effort } from "../../domain.js";

/** One private chat. `channel` is `web:<id>`. storageServer null = the chat's server, for its image and file keys. */
export interface WebChatRow { id: string; server: string; owner: string; title: string; created: number; updated: number; deleted: boolean; effort?: Effort; project?: string; storageServer: string | null; titleSource: "auto" | "model" | "user"; bytesPerToken?: number }

const COLUMNS = "id,server,owner,title,created,updated,deleted,effort,project,storage_server,title_source,bytes_per_token";

function chatOf(row: Record<string, unknown>): WebChatRow {
  return { id: String(row.id), server: String(row.server), owner: String(row.owner), title: String(row.title), created: Number(row.created), updated: Number(row.updated), deleted: Number(row.deleted) === 1, ...(parseEffort(row.effort) ? { effort: parseEffort(row.effort)! } : {}), ...(row.project ? { project: String(row.project) } : {}), storageServer: row.storage_server == null ? null : String(row.storage_server), titleSource: row.title_source === "model" || row.title_source === "user" ? row.title_source : "auto", ...(row.bytes_per_token == null ? {} : { bytesPerToken: Number(row.bytes_per_token) }) };
}

export async function insertWebChat(db: ChatDb, row: WebChatRow): Promise<void> {
  await db.prepare("INSERT INTO web_chats(id,server,owner,title,created,updated,deleted,project,storage_server,title_source) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(row.id, row.server, row.owner, row.title, row.created, row.updated, row.deleted ? 1 : 0, row.project ?? null, row.storageServer, row.titleSource);
}

/** A chat that was deleted is still returned here, with deleted set, so callers can refuse it. */
export async function getWebChat(db: ChatDb, id: string): Promise<WebChatRow | undefined> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM web_chats WHERE id=?`).get(id);
  return row ? chatOf(row) : undefined;
}

/** Live chats of one owner in all servers, newest first. A private chat belongs to its owner, not to a server. */
export async function listWebChats(db: ChatDb, owner: string): Promise<WebChatRow[]> {
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM web_chats WHERE owner=? AND deleted=0 ORDER BY updated DESC, id`).all(owner);
  return rows.map(chatOf);
}

/** Live chats of one owner in one project, newest first. The chats may be in different servers. */
export async function webChatsInProject(db: ChatDb, owner: string, project: string): Promise<WebChatRow[]> {
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM web_chats WHERE owner=? AND project=? AND deleted=0 ORDER BY updated DESC, id`).all(owner, project);
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

/** Sets the title and where it came from. A model title never replaces a user title: one statement checks it. */
export async function setWebChatTitle(db: ChatDb, id: string, title: string, source: "model" | "user", updated: number): Promise<void> {
  await db.prepare("UPDATE web_chats SET title=?, title_source=?, updated=? WHERE id=? AND (title_source<>'user' OR ?='user')").run(title, source, updated, id, source);
}

/** Live chats that still have an automatic title, in all servers and for all owners, newest first. */
export async function autoTitledWebChats(db: ChatDb): Promise<WebChatRow[]> {
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM web_chats WHERE title_source='auto' AND deleted=0 ORDER BY updated DESC, id`).all();
  return rows.map(chatOf);
}

/** Bytes of text per token, measured for one chat. null in the database means the default. */
export async function setBytesPerToken(db: ChatDb, chat: string, ratio: number): Promise<void> {
  await db.prepare("UPDATE web_chats SET bytes_per_token=? WHERE id=?").run(ratio, chat);
}

/** The newest summary of a web chat. */
export async function webChatSummary(db: ChatDb, chat: string): Promise<{ throughMessage: string; throughTimestamp: number; summary: string } | undefined> {
  const row = await db.prepare("SELECT through_message,through_timestamp,summary FROM web_chat_summaries WHERE chat=? ORDER BY created DESC LIMIT 1").get(chat);
  return row ? { throughMessage: String(row.through_message), throughTimestamp: Number(row.through_timestamp), summary: String(row.summary) } : undefined;
}

export async function saveWebChatSummary(db: ChatDb, chat: string, row: { throughMessage: string; throughTimestamp: number; summary: string; runId: string }): Promise<void> {
  // A second save in the same millisecond replaces the first, so the newest summary always wins.
  await db.prepare("INSERT INTO web_chat_summaries(chat,through_message,through_timestamp,summary,run_id,created) VALUES(?,?,?,?,?,?) ON CONFLICT(chat,created) DO UPDATE SET through_message=excluded.through_message, through_timestamp=excluded.through_timestamp, summary=excluded.summary, run_id=excluded.run_id")
    .run(chat, row.throughMessage, row.throughTimestamp, row.summary, row.runId, Date.now());
}

export async function touchWebChat(db: ChatDb, id: string, updated: number): Promise<void> {
  await db.prepare("UPDATE web_chats SET updated=? WHERE id=? AND deleted=0").run(updated, id);
}

export async function setWebChatEffort(db: ChatDb, id: string, effort: Effort | null): Promise<void> {
  await db.prepare("UPDATE web_chats SET effort=? WHERE id=? AND deleted=0").run(effort, id);
}

/** Puts a chat in a project, or takes it out with null. Also sets updated, so a moved chat is first in its new list. */
export async function setChatProject(db: ChatDb, id: string, project: string | null, at: number): Promise<void> {
  await db.prepare("UPDATE web_chats SET project=?, updated=? WHERE id=? AND deleted=0").run(project, at, id);
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
  // Rows of the removed live stream stay until they expire, so they go with the chat too.
  await db.prepare("DELETE FROM conversation_events WHERE server=? AND channel=?").run(server, channel);
  await db.prepare("DELETE FROM engine_events WHERE server=? AND channel=?").run(server, channel);
}
