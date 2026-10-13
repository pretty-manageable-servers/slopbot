import { parseMessage, type Json } from "./domain.js";
import type { ShareListRow, ShareMessageRange, ShareMessageResult, ShareRow } from "./shares.js";

// Works for both the SQLite handle (synchronous) and the Postgres wrapper (async).
// Queries use `?` placeholders and json_extract, which the Postgres wrapper translates.
export interface ShareDb {
  prepare(sql: string): { all(...values: any[]): any; get(...values: any[]): any; run(...values: any[]): any };
}

const moment = "coalesce(json_extract(body,'$.timestamp'),sequence)";

async function momentOf(db: ShareDb, server: string, channel: string, id: string): Promise<number | undefined> {
  const row = await db.prepare(`SELECT ${moment} AS moment FROM messages WHERE server=? AND channel=? AND id=?`).get(server, channel, id);
  return row ? Number(row.moment) : undefined;
}

/** Newest first from the query, then returned in time order. The caller decides what to do with `more`. */
export async function shareMessages(db: ShareDb, server: string, channel: string, range: ShareMessageRange): Promise<ShareMessageResult> {
  const low = range.from === undefined ? Number.MIN_SAFE_INTEGER : await momentOf(db, server, channel, range.from);
  const high = range.to === undefined ? Number.MAX_SAFE_INTEGER : await momentOf(db, server, channel, range.to);
  if (low === undefined || high === undefined) return { messages: [], more: false };
  const rows = await db.prepare(`SELECT body FROM messages WHERE server=? AND channel=?
      AND ${moment} >= ? AND ${moment} <= ?
      AND NOT EXISTS (SELECT 1 FROM message_tombstones t WHERE t.server=messages.server AND t.id=messages.id)
      ORDER BY ${moment} DESC, id DESC LIMIT ?`).all(server, channel, low, high, range.limit + 1) as { body: string }[];
  const kept = rows.slice(0, range.limit).reverse();
  return { messages: kept.map(row => parseMessage(JSON.parse(String(row.body)))), more: rows.length > range.limit };
}

/** Tool-call and reasoning events of the reply runs for these request message IDs. Text and usage events are not read. */
export async function shareRequestEvents(db: ShareDb, server: string, requests: readonly string[]): Promise<readonly { request: string; kind: string; payload: Json }[]> {
  if (!requests.length) return [];
  const marks = requests.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT json_extract(r.message,'$.id') AS request, e.kind AS kind, e.payload AS payload
      FROM runs r JOIN events e ON e.run_id=r.id
      WHERE json_extract(r.message,'$.server')=? AND json_extract(r.message,'$.id') IN (${marks})
      AND e.kind IN ('tool_call','reasoning')
      AND (json_extract(r.prompt,'$.purpose') IS NULL OR json_extract(r.prompt,'$.purpose')='reply')
      ORDER BY r.rowid, e.sequence`).all(server, ...requests) as { request: string; kind: string; payload: string }[];
  return rows.map(row => ({ request: String(row.request), kind: String(row.kind), payload: JSON.parse(String(row.payload)) as Json }));
}

export async function insertShare(db: ShareDb, row: ShareRow): Promise<void> {
  await db.prepare("INSERT INTO shares(id,server,channel,created_by,created_at,revoked_at,body) VALUES(?,?,?,?,?,NULL,?)")
    .run(row.id, row.server, row.channel, row.created_by, row.created_at, row.body);
}

export async function getShare(db: ShareDb, id: string): Promise<ShareRow | undefined> {
  const row = await db.prepare("SELECT id,server,channel,created_by,created_at,revoked_at,body FROM shares WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return { id: String(row.id), server: String(row.server), channel: String(row.channel), created_by: String(row.created_by),
    created_at: Number(row.created_at), revoked_at: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at), body: String(row.body) };
}

// Private chat links (channel web:...) are kept out of the server list and of revoke-all. Only the owner's list shows them.
export async function listShares(db: ShareDb, server: string, limit: number): Promise<ShareListRow[]> {
  const rows = await db.prepare("SELECT id,channel,created_at,revoked_at FROM shares WHERE server=? AND channel NOT LIKE 'web:%' ORDER BY created_at DESC, id DESC LIMIT ?").all(server, limit) as Record<string, unknown>[];
  return shareRows(rows);
}

export async function listChatShares(db: ShareDb, server: string, channel: string, limit: number): Promise<ShareListRow[]> {
  const rows = await db.prepare("SELECT id,channel,created_at,revoked_at FROM shares WHERE server=? AND channel=? ORDER BY created_at DESC, id DESC LIMIT ?").all(server, channel, limit) as Record<string, unknown>[];
  return shareRows(rows);
}

function shareRows(rows: Record<string, unknown>[]): ShareListRow[] {
  return rows.map(row => ({ id: String(row.id), channel: String(row.channel), created_at: Number(row.created_at),
    revoked_at: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at) }));
}

export async function revokeShare(db: ShareDb, server: string, id: string, at: number): Promise<boolean> {
  const result = await db.prepare("UPDATE shares SET revoked_at=coalesce(revoked_at,?) WHERE server=? AND id=?").run(at, server, id);
  return result.changes > 0;
}

export async function revokeAllShares(db: ShareDb, server: string, at: number): Promise<number> {
  const result = await db.prepare("UPDATE shares SET revoked_at=? WHERE server=? AND revoked_at IS NULL AND channel NOT LIKE 'web:%'").run(at, server);
  return result.changes;
}

export async function deleteChatShares(db: ShareDb, channel: string): Promise<number> {
  const result = await db.prepare("DELETE FROM shares WHERE channel=?").run(channel);
  return result.changes;
}
