import type { DatabaseSync } from "node:sqlite";
import type { SQLiteStore } from "../adapters/sqlite.js";
import type { Effort } from "../domain.js";
import type { AssistantStore } from "./store.js";
import type { ActivityItem, ApprovalRequest, AssistantSettings, AssistantTask, Trigger, TaskPause, TaskStatus, Wake } from "./types.js";

type Row = Record<string, any>;
type Maybe<T> = T | Promise<T>;

/** The part of a database handle the assistant SQL needs. node:sqlite and PostgresDatabase both fit. */
export interface AssistantDb {
  prepare(sql: string): {
    get(...values: unknown[]): Maybe<Row | undefined>;
    all(...values: unknown[]): Maybe<Row[]>;
    run(...values: unknown[]): Maybe<{ changes: number | bigint }>;
  };
}

const bit = (value: boolean) => value ? 1 : 0;
const changed = (result: { changes: number | bigint }) => Number(result.changes) > 0;

function settingsFrom(row: Row): AssistantSettings {
  return { user: row.user_id, enabled: Boolean(row.enabled), briefCron: row.brief_cron, timezone: row.timezone, dmUpdates: Boolean(row.dm_updates), quietStart: row.quiet_start, quietEnd: row.quiet_end, updated: row.updated };
}
function taskFrom(row: Row): AssistantTask {
  return {
    id: row.id, owner: row.owner, goal: row.goal, instructions: row.instructions, status: row.status as TaskStatus, pause: row.pause as TaskPause | null,
    wake: JSON.parse(row.wake) as Wake, nextAt: row.next_at, rules: JSON.parse(row.rules), effort: row.effort as Effort, failures: row.failures,
    lastRunAt: row.last_run_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
  };
}
function approvalFrom(row: Row): ApprovalRequest {
  return {
    id: row.id, owner: row.owner, task: row.task, run: row.run, tool: row.tool, input: JSON.parse(row.input), summary: row.summary,
    status: row.status as ApprovalRequest["status"], result: row.result, createdAt: row.created_at, decidedAt: row.decided_at, expiresAt: row.expires_at,
  };
}
function activityFrom(row: Row): ActivityItem {
  return { id: row.id, owner: row.owner, task: row.task, kind: row.kind, text: row.text, ref: row.ref, createdAt: row.created_at, readAt: row.read_at };
}
function triggerFrom(row: Row): Trigger {
  return { id: row.id, owner: row.owner, task: row.task, kind: row.kind, payload: JSON.parse(row.payload), createdAt: row.created_at, takenAt: row.taken_at };
}

/** Assistant store SQL shared by SQLite and Postgres. The `?` placeholders are translated by the Postgres adapter. */
export abstract class AssistantSqlStore implements AssistantStore {
  constructor(protected readonly db: AssistantDb) {}

  async settings(user: string): Promise<AssistantSettings | undefined> {
    const row = await this.db.prepare("SELECT * FROM assistant_settings WHERE user_id=?").get(user);
    return row && settingsFrom(row);
  }

  // brief_next_at is not in AssistantSettings, so the upsert leaves it alone. setBriefNextAt owns it.
  async putSettings(s: AssistantSettings): Promise<void> {
    await this.db.prepare(`INSERT INTO assistant_settings (user_id,enabled,brief_cron,timezone,dm_updates,quiet_start,quiet_end,updated) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,brief_cron=excluded.brief_cron,timezone=excluded.timezone,dm_updates=excluded.dm_updates,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,updated=excluded.updated`)
      .run(s.user, bit(s.enabled), s.briefCron, s.timezone, bit(s.dmUpdates), s.quietStart, s.quietEnd, s.updated);
  }

  async setBriefNextAt(user: string, at: number | null): Promise<void> {
    await this.db.prepare("UPDATE assistant_settings SET brief_next_at=? WHERE user_id=?").run(at, user);
  }

  async dueBriefs(now: number, limit: number): Promise<AssistantSettings[]> {
    const rows = await this.db.prepare("SELECT * FROM assistant_settings WHERE enabled=1 AND brief_cron IS NOT NULL AND brief_next_at<=? ORDER BY brief_next_at LIMIT ?").all(now, limit);
    return rows.map(settingsFrom);
  }

  async tasks(owner: string): Promise<AssistantTask[]> {
    const rows = await this.db.prepare("SELECT * FROM assistant_tasks WHERE owner=? ORDER BY created_at, id").all(owner);
    return rows.map(taskFrom);
  }

  async task(id: string): Promise<AssistantTask | undefined> {
    const row = await this.db.prepare("SELECT * FROM assistant_tasks WHERE id=?").get(id);
    return row && taskFrom(row);
  }

  // expectedRevision null inserts at revision 1 and reports false when the id exists. A number is a CAS on revision.
  async putTask(t: AssistantTask, expectedRevision: number | null): Promise<boolean> {
    if (expectedRevision === null) {
      return changed(await this.db.prepare(`INSERT INTO assistant_tasks (id,owner,goal,instructions,status,pause,wake,next_at,rules,effort,failures,last_run_at,last_error,created_at,updated_at,revision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO NOTHING`)
        .run(t.id, t.owner, t.goal, t.instructions, t.status, t.pause, JSON.stringify(t.wake), t.nextAt, JSON.stringify(t.rules), t.effort, t.failures, t.lastRunAt, t.lastError, t.createdAt, t.updatedAt));
    }
    return changed(await this.db.prepare(`UPDATE assistant_tasks SET owner=?,goal=?,instructions=?,status=?,pause=?,wake=?,next_at=?,rules=?,effort=?,failures=?,last_run_at=?,last_error=?,updated_at=?,revision=?
      WHERE id=? AND revision=?`)
      .run(t.owner, t.goal, t.instructions, t.status, t.pause, JSON.stringify(t.wake), t.nextAt, JSON.stringify(t.rules), t.effort, t.failures, t.lastRunAt, t.lastError, t.updatedAt, expectedRevision + 1, t.id, expectedRevision));
  }

  async dueTasks(now: number, limit: number): Promise<AssistantTask[]> {
    const rows = await this.db.prepare("SELECT * FROM assistant_tasks WHERE status='active' AND next_at<=? ORDER BY next_at LIMIT ?").all(now, limit);
    return rows.map(taskFrom);
  }

  async addTrigger(t: Trigger): Promise<void> {
    await this.db.prepare("INSERT INTO assistant_triggers (id,owner,task,kind,payload,created_at,taken_at) VALUES (?,?,?,?,?,?,?)")
      .run(t.id, t.owner, t.task, t.kind, JSON.stringify(t.payload), t.createdAt, t.takenAt);
  }

  // One UPDATE ... RETURNING statement is atomic on both engines, so no explicit transaction is needed.
  async takeTriggers(owner: string, now: number): Promise<Trigger[]> {
    const rows = await this.db.prepare("UPDATE assistant_triggers SET taken_at=? WHERE owner=? AND taken_at IS NULL RETURNING *").all(now, owner);
    return rows.map(triggerFrom).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async addApproval(a: ApprovalRequest): Promise<void> {
    await this.db.prepare("INSERT INTO assistant_approvals (id,owner,task,run,tool,input,summary,status,result,created_at,decided_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(a.id, a.owner, a.task, a.run, a.tool, JSON.stringify(a.input), a.summary, a.status, a.result, a.createdAt, a.decidedAt, a.expiresAt);
  }

  async approval(id: string): Promise<ApprovalRequest | undefined> {
    const row = await this.db.prepare("SELECT * FROM assistant_approvals WHERE id=?").get(id);
    return row && approvalFrom(row);
  }

  async decideApproval(id: string, status: ApprovalRequest["status"], result: string | null, now: number): Promise<boolean> {
    return changed(await this.db.prepare("UPDATE assistant_approvals SET status=?,result=?,decided_at=? WHERE id=? AND status='pending'").run(status, result, now, id));
  }

  async pendingApprovals(owner: string): Promise<ApprovalRequest[]> {
    const rows = await this.db.prepare("SELECT * FROM assistant_approvals WHERE owner=? AND status='pending' ORDER BY created_at DESC, id DESC").all(owner);
    return rows.map(approvalFrom);
  }

  async addActivity(a: ActivityItem): Promise<void> {
    await this.db.prepare("INSERT INTO assistant_activity (id,owner,task,kind,text,ref,created_at,read_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(a.id, a.owner, a.task, a.kind, a.text, a.ref, a.createdAt, a.readAt);
  }

  async activity(owner: string, before: number | null, limit: number): Promise<ActivityItem[]> {
    const rows = before === null
      ? await this.db.prepare("SELECT * FROM assistant_activity WHERE owner=? ORDER BY created_at DESC, id DESC LIMIT ?").all(owner, limit)
      : await this.db.prepare("SELECT * FROM assistant_activity WHERE owner=? AND created_at<? ORDER BY created_at DESC, id DESC LIMIT ?").all(owner, before, limit);
    return rows.map(activityFrom);
  }

  // Keeps the first read time. Ids that belong to another owner are ignored.
  async markRead(owner: string, ids: string[], now: number): Promise<void> {
    if (ids.length === 0) return;
    await this.db.prepare(`UPDATE assistant_activity SET read_at=? WHERE owner=? AND read_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`)
      .run(now, owner, ...ids);
  }
}

export class SqliteAssistantStore extends AssistantSqlStore {
  constructor(db: DatabaseSync) { super(db); }
}

/** Reads the private handle of a SQLiteStore. The adapter stays untouched. */
export function sqliteAssistantStore(store: SQLiteStore): SqliteAssistantStore {
  return new SqliteAssistantStore((store as unknown as { db: DatabaseSync }).db);
}
