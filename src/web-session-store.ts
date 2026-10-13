/** One web console login. The session id is never stored. Only its SHA-256 hash is. */
export interface WebSessionRow { id_hash: string; user_id: string; csrf: string; expires: number; created: number }

/** Session calls used by the web console. SQLite and Postgres implement them with the helpers below. */
export interface WebSessionStore {
  getSession(idHash: string): Promise<WebSessionRow | undefined>;
  /** Inserts a session, or replaces the row with the same hash (used to extend expires). */
  saveSession(row: WebSessionRow): Promise<void>;
  deleteSession(idHash: string): Promise<void>;
  /** Deletes sessions that ended at or before `now`. Returns how many rows were removed. */
  deleteExpiredSessions(now: number): Promise<number>;
}

// Works for both the SQLite handle (synchronous) and the Postgres wrapper (async).
export interface WebSessionDb {
  prepare(sql: string): { get(...values: any[]): any; run(...values: any[]): any };
}

export async function getWebSession(db: WebSessionDb, idHash: string): Promise<WebSessionRow | undefined> {
  const row = await db.prepare("SELECT id_hash,user_id,csrf,expires,created FROM web_sessions WHERE id_hash=?").get(idHash) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return { id_hash: String(row.id_hash), user_id: String(row.user_id), csrf: String(row.csrf), expires: Number(row.expires), created: Number(row.created) };
}

export async function saveWebSession(db: WebSessionDb, row: WebSessionRow): Promise<void> {
  await db.prepare("INSERT INTO web_sessions(id_hash,user_id,csrf,expires,created) VALUES(?,?,?,?,?) ON CONFLICT(id_hash) DO UPDATE SET user_id=excluded.user_id,csrf=excluded.csrf,expires=excluded.expires")
    .run(row.id_hash, row.user_id, row.csrf, row.expires, row.created);
}

export async function deleteWebSession(db: WebSessionDb, idHash: string): Promise<void> {
  await db.prepare("DELETE FROM web_sessions WHERE id_hash=?").run(idHash);
}

export async function deleteExpiredWebSessions(db: WebSessionDb, now: number): Promise<number> {
  const result = await db.prepare("DELETE FROM web_sessions WHERE expires<=?").run(now);
  return result.changes;
}
