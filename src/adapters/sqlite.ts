import { readParticipationHistory, type ParticipationHistoryQuery } from '../participation-history.js';
import { contextChangedError, legacyToolProgress, sourceFingerprint, type ContextChange } from "../source-context.js";
import { logError } from "../errors.js";
import type { HarnessJournal, HarnessState, HarnessEvent } from "../harness-state.js";
import type { ToolOutput } from "../tools.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { parseMessage, type Effort, type Json, type Message, type ModelEvent, type Prompt, type PromptItem } from "../domain.js";
import type { Store, AgentTurn, UserLimitWindow, UserLimitState, UserLimitRow, TokenTotals, UserTokenTotalRow, TokenTotalsSummary, KnownUserPage } from "../ports.js";
import type { KeyedProvider, ProviderKeyRow, ProviderKeyUsage } from "../web-providers.js";
import { cosine, searchTerms, type Embeddings, type Evidence, type Knowledge, type MemoryRecord, type Recall } from "../memory.js";
import { attribution, type Attribution } from "../usage-meter.js";

import { ToolError } from "../tools.js";
import type { ProfileField, ProfileStore, UserProfile } from "../profiles.js";
import type { TaskContext } from "../context.js";
import type { Job, QueueStore } from "../queue.js";
import type { BlockingOperation, ToolArgs, ToolCall, ToolContext, ToolJournal, ToolOperation } from "../tools.js";

import type { HistoryQuery, HistoryPage } from '../search/history-search.js';
import { FUZZY_SCAN, FUZZY_TERMS, fuzzyWords, likePattern, rankFuzzy, type FuzzyHit, type FuzzyQuery } from '../search/fuzzy.js';
import type { AppRecord } from '../records.js';
import type { ConversationEvent } from '../run-events.js';
import type { ChannelReply, ChannelRun, RunSource } from '../conversation-groups.js';
/** Rows deleted by one retention statement, so a large prune never holds the database for long. */
const CONVERSATION_PRUNE_BATCH = 10000;

import type { WebReplyRow, WebVia, WebWebhookRow } from '../web-replies.js';
import type { InboxItem } from '../inbox.js';
import { shareMessages, shareRequestEvents, insertShare, getShare, listShares, listChatShares, revokeShare, revokeAllShares, deleteChatShares } from '../share-store.js';
import { getWebSession, saveWebSession, deleteWebSession, deleteExpiredWebSessions } from '../web-session-store.js';
import { insertWebChat, getWebChat, listWebChats, liveWebChatChannels, renameWebChat, setWebChatEffort, touchWebChat, markWebChatDeleted, deleteChatRows, type WebChatRow } from '../web-chat-store.js';
import { isPrivateChannel } from '../private-chat.js';
import type { WebSessionRow } from '../web-session-store.js';
import type { ShareMessageRange, ShareMessageResult, ShareRow } from '../shares.js';
import { promptInventory, saveRunRuntime } from '../run-diagnostics.js';
function inboxItemFromRow(row: Record<string, any>): InboxItem {
  return { id: String(row.id), server: String(row.server), target: String(row.target), sender: String(row.sender), channel: String(row.channel), sourceIds: JSON.parse(String(row.source_ids)) as string[], summary: String(row.summary), created_at: Number(row.created_at), done_at: row.done_at === null ? null : Number(row.done_at) };
}
function providerKeyRow(row: Record<string, unknown>): ProviderKeyRow {
  return { id: String(row.id), provider: String(row.provider) as KeyedProvider, owner: String(row.owner), label: String(row.label), last4: String(row.last4), secretEncrypted: String(row.secret_encrypted), createdAt: Number(row.created_at) };
}
export class SQLiteStore implements HarnessJournal, Store, Knowledge, Recall, QueueStore, ToolJournal, ProfileStore {
  async participationHistory(server: string, channel: string, query: ParticipationHistoryQuery) {
    return readParticipationHistory(async (sql, values) => this.db.prepare(sql).all(...values), server, channel, query);
  }
  async record(
    server: string,
    kind: string,
    id: string,
  ): Promise<AppRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM app_records WHERE server=? AND kind=? AND id=?")
      .get(server, kind, id);
    return row
      ? {
          id: String(row.id),
          revision: Number(row.revision),
          value: JSON.parse(String(row.value)) as Json,
        }
      : undefined;
  }
  async records(server: string, kind: string): Promise<AppRecord[]> {
    return this.db
      .prepare(
        "SELECT * FROM app_records WHERE server=? AND kind=? ORDER BY id",
      )
      .all(server, kind)
      .map((row) => ({
        id: String(row.id),
        revision: Number(row.revision),
        value: JSON.parse(String(row.value)) as Json,
      }));
  }
  async putRecord(
    server: string,
    kind: string,
    id: string,
    value: Json,
    expectedRevision: number,
  ): Promise<boolean> {
    if (expectedRevision === 0)
      return (
        this.db
          .prepare(
            "INSERT OR IGNORE INTO app_records(server,kind,id,revision,value) VALUES(?,?,?,1,?)",
          )
          .run(server, kind, id, JSON.stringify(value)).changes === 1
      );
    return (
      this.db
        .prepare(
          "UPDATE app_records SET value=?,revision=revision+1 WHERE server=? AND kind=? AND id=? AND revision=?",
        )
        .run(JSON.stringify(value), server, kind, id, expectedRevision)
        .changes === 1
    );
  }
  /**
   * Fuzzy search of one channel for the web console. Candidates are the newest FUZZY_SCAN messages plus LIKE
   * hits for the query words; TypeScript scores them (see search/fuzzy.ts). Access checks are the caller's job.
   */
  async searchFuzzy(request: FuzzyQuery): Promise<FuzzyHit[]> {
    const candidates = new Map<string, Message>();
    const recent = this.db
      .prepare("SELECT m.body FROM messages m WHERE m.server=? AND m.channel=? ORDER BY json_extract(m.body,'$.timestamp') DESC,m.id DESC LIMIT ?")
      .all(request.server, request.channel, FUZZY_SCAN);
    const words = fuzzyWords(request.query).slice(0, FUZZY_TERMS);
    const hits = words.length
      ? this.db
          .prepare(`SELECT m.body FROM messages m WHERE m.server=? AND m.channel=? AND (${words.map(() => "lower(json_extract(m.body,'$.text')) LIKE ? ESCAPE '\\'").join(" OR ")}) ORDER BY json_extract(m.body,'$.timestamp') DESC,m.id DESC LIMIT 200`)
          .all(request.server, request.channel, ...words.map(likePattern))
      : [];
    for (const row of [...recent, ...hits]) {
      const message = parseMessage(JSON.parse(String(row.body)));
      candidates.set(message.id, message);
    }
    return rankFuzzy(request.query, [...candidates.values()], request.limit).map((hit) => ({ message: this.namedMessage(hit.message), score: hit.score }));
  }
  async searchHistory(request: HistoryQuery): Promise<HistoryPage> {
    const filters = ["m.server=?", "m.channel=?"];
    const values: (string | number)[] = [request.server, request.channel];
    if (request.author) {
      filters.push("json_extract(m.body,'$.author')=?");
      values.push(request.author);
    }
    if (request.after !== undefined) {
      filters.push("json_extract(m.body,'$.timestamp')>=?");
      values.push(request.after);
    }
    if (request.before !== undefined) {
      filters.push("json_extract(m.body,'$.timestamp')<=?");
      values.push(request.before);
    }
    if (request.excludeId) {
      filters.push("m.id<>?");
      values.push(request.excludeId);
    }
    const where = filters.join(" AND ");
    const terms = searchTerms(request.query);
    const pattern = request.mode === "exact" ? [request.query] : terms;
    const matches = pattern.length
      ? " AND (" +
        pattern
          .map(() => "lower(json_extract(m.body,'$.text')) LIKE ? ESCAPE '\\'")
          .join(" OR ") +
        ")"
      : "";
    let keywords = this.db
      .prepare(
        `SELECT m.body FROM messages m WHERE ${where}${matches} ORDER BY json_extract(m.body,'$.timestamp') DESC,m.id DESC LIMIT 200`,
      )
      .all(
        ...values,
        ...pattern.map(
          (term) => "%" + term.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%",
        ),
      )
      .map((row) => parseMessage(JSON.parse(String(row.body))));
    if (this.fts && request.mode !== "exact" && terms.length) {
      const query = terms.map((term) => `"${term}"`).join(" OR ");
      keywords = this.db
        .prepare(
          `SELECT m.body FROM message_search JOIN messages m ON m.sequence=message_search.rowid WHERE message_search MATCH ? AND ${where} ORDER BY bm25(message_search),json_extract(m.body,'$.timestamp') DESC,m.id DESC LIMIT 200`,
        )
        .all(query, ...values)
        .map((row) => parseMessage(JSON.parse(String(row.body))));
    }
    const degraded = request.mode === "semantic" || request.mode === "hybrid";
    const lists = [keywords];
    const scores = new Map<string, { message: Message; score: number }>();
    for (const list of lists)
      list.forEach((message, index) => {
        const entry = scores.get(message.id) ?? { message, score: 0 };
        entry.score += 1 / (60 + index + 1);
        scores.set(message.id, entry);
      });
    const ranked = [...scores.values()].sort(
      (a, b) => b.score - a.score || a.message.id.localeCompare(b.message.id),
    );
    const offset = request.offset ?? 0;
    const selected = ranked.slice(offset, offset + request.limit);
    const messages: Message[] = [];
    for (const item of selected)
      messages.push(await this.namedMessage(item.message));
    const stats = await this.indexStats(request.server, request.channel);
    return {
      messages,
      nextOffset:
        offset + request.limit < ranked.length
          ? offset + request.limit
          : undefined,
      degraded,
      coverage: {
        messages: stats.messages,
        vectors: stats.vectors,
        oldest: stats.oldest,
        newest: stats.newest,
      },
      candidateLimit: 200,
    };
  }

  async readHistory(
    server: string,
    channel: string,
    id: string,
    radius: number,
  ): Promise<Message[]> {
    const target = this.db
      .prepare(
        "SELECT body FROM messages WHERE server=? AND channel=? AND id=?",
      )
      .get(server, channel, id);
    if (!target) return [];
    const time = parseMessage(JSON.parse(String(target.body))).timestamp ?? 0;
    const before = this.db
      .prepare(
        "SELECT body FROM messages WHERE server=? AND channel=? AND (COALESCE(json_extract(body,'$.timestamp'),0)<? OR (COALESCE(json_extract(body,'$.timestamp'),0)=? AND id<?)) ORDER BY COALESCE(json_extract(body,'$.timestamp'),0) DESC,id DESC LIMIT ?",
      )
      .all(server, channel, time, time, id, radius);
    const after = this.db
      .prepare(
        "SELECT body FROM messages WHERE server=? AND channel=? AND (COALESCE(json_extract(body,'$.timestamp'),0)>? OR (COALESCE(json_extract(body,'$.timestamp'),0)=? AND id>=?)) ORDER BY COALESCE(json_extract(body,'$.timestamp'),0),id LIMIT ?",
      )
      .all(server, channel, time, time, id, radius + 1);
    const messages = [...before.reverse(), ...after].map((row) =>
      parseMessage(JSON.parse(String(row.body))),
    );
    const root = messages.find((message) => message.id === id);
    let reply = root?.replyTo;
    for (let depth = 0; reply && depth < 4; depth++) {
      const parent = await this.canonicalMessage(server, reply);
      if (
        !parent ||
        parent.channel !== channel ||
        messages.some((item) => item.id === parent.id)
      )
        break;
      messages.unshift(parent);
      reply = parent.replyTo;
    }
    return Promise.all(messages.map((message) => this.namedMessage(message)));
  }

  private readonly db: DatabaseSync;
  private readonly fts: boolean;
  private indexTail: Promise<void> = Promise.resolve();

  constructor(path = ":memory:", private readonly embeddings?: Embeddings) {
    this.db = new DatabaseSync(path);
    const existingSearch = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='message_search'").get();
    if (existingSearch) {
      this.fts = String(existingSearch.sql).includes("fts5");
    } else try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(text)");
      this.fts = true;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("no such module: fts5")) throw error;
      this.db.exec("CREATE TABLE IF NOT EXISTS message_search (text TEXT NOT NULL)");
      this.fts = false;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_records (server TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision BIGINT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(server,kind,id));
      CREATE TABLE IF NOT EXISTS harness_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL, message_id TEXT NOT NULL,
        state TEXT NOT NULL, event TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        server TEXT NOT NULL, id TEXT NOT NULL, channel TEXT NOT NULL,
        body TEXT NOT NULL, UNIQUE(server, id)
      );
      CREATE TABLE IF NOT EXISTS author_directory (server TEXT NOT NULL, author TEXT NOT NULL, names TEXT NOT NULL, bot INTEGER NOT NULL, PRIMARY KEY(server,author));
      CREATE TABLE IF NOT EXISTS profile_events (
        id TEXT NOT NULL UNIQUE, server TEXT NOT NULL, user_id TEXT NOT NULL, field TEXT NOT NULL,
        value TEXT NOT NULL, editor TEXT NOT NULL, sources TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1,
        sequence INTEGER PRIMARY KEY AUTOINCREMENT
      );
      CREATE TABLE IF NOT EXISTS profile_current (server TEXT NOT NULL,user_id TEXT NOT NULL,field TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(server,user_id,field));
      CREATE TABLE IF NOT EXISTS profile_locks (server TEXT NOT NULL,user_id TEXT NOT NULL,allow_edits INTEGER NOT NULL,PRIMARY KEY(server,user_id));
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, message TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS task_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_key TEXT NOT NULL, item TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_threads (
        server TEXT NOT NULL, thread TEXT NOT NULL, parent TEXT NOT NULL,
        PRIMARY KEY(server, thread)
      );
      CREATE TABLE IF NOT EXISTS context_versions (
        server TEXT NOT NULL, channel TEXT NOT NULL, version INTEGER NOT NULL,
        PRIMARY KEY(server,channel)
      );
      CREATE TRIGGER IF NOT EXISTS messages_search_insert AFTER INSERT ON messages BEGIN
        INSERT INTO message_search(rowid,text) VALUES(NEW.sequence,json_extract(NEW.body,'$.text'));
      END;
      CREATE TRIGGER IF NOT EXISTS messages_search_update AFTER UPDATE ON messages BEGIN
        DELETE FROM message_search WHERE rowid=OLD.sequence;
        INSERT INTO message_search(rowid,text) VALUES(NEW.sequence,json_extract(NEW.body,'$.text'));
      END;
      CREATE TRIGGER IF NOT EXISTS messages_search_delete AFTER DELETE ON messages BEGIN
        DELETE FROM message_search WHERE rowid=OLD.sequence;
      END;
      INSERT INTO message_search(rowid,text)
        SELECT sequence,json_extract(body,'$.text') FROM messages
        WHERE sequence NOT IN (SELECT rowid FROM message_search);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, server TEXT NOT NULL, channel TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_sources (
        memory_id TEXT NOT NULL, server TEXT NOT NULL, message_id TEXT NOT NULL,
        PRIMARY KEY(memory_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        server TEXT NOT NULL, memory_id TEXT NOT NULL, model TEXT NOT NULL,
        vector TEXT NOT NULL, PRIMARY KEY(server,memory_id,model)
      );
      CREATE TABLE IF NOT EXISTS run_sources (
        run_id TEXT NOT NULL, server TEXT NOT NULL, message_id TEXT NOT NULL,
        PRIMARY KEY(run_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS source_dependents (
        server TEXT NOT NULL, source_id TEXT NOT NULL, output_id TEXT NOT NULL,
        PRIMARY KEY(server,source_id,output_id)
      );
      CREATE TABLE IF NOT EXISTS message_tombstones (
        server TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(server,id)
      );
      CREATE TABLE IF NOT EXISTS embedding_usage (
        server TEXT NOT NULL, channel TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, unknown_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(server,channel,model,purpose)
      );
      DROP TABLE IF EXISTS embeddings;
      DELETE FROM embedding_usage WHERE purpose IN ('index','query');
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_key TEXT NOT NULL, through_sequence INTEGER NOT NULL,
        item TEXT NOT NULL, run_id TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS agent_turns (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, server TEXT NOT NULL, message_id TEXT NOT NULL,
        text TEXT NOT NULL, calls TEXT NOT NULL, results TEXT NOT NULL, version INTEGER NOT NULL, valid INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS tool_operations (
        id TEXT PRIMARY KEY, server TEXT NOT NULL, channel TEXT NOT NULL, author TEXT NOT NULL,
        message_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        server TEXT NOT NULL, channel TEXT NOT NULL, message_id TEXT NOT NULL, message TEXT NOT NULL,
        status TEXT NOT NULL, reply TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
        UNIQUE(server,message_id)
      );
      CREATE TABLE IF NOT EXISTS worker_leases (server TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, message TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, result TEXT);
      CREATE INDEX IF NOT EXISTS deliveries_created ON deliveries(created_at);
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(server,status,sequence);
      CREATE TABLE IF NOT EXISTS settings (server TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(server,key));
      CREATE TABLE IF NOT EXISTS user_limit_counters (server TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, window_start INTEGER NOT NULL, spent INTEGER NOT NULL, PRIMARY KEY(server,user_id,kind));
      CREATE TABLE IF NOT EXISTS user_limit_resets (server TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(server,user_id,kind));
      CREATE TABLE IF NOT EXISTS user_token_totals (server TEXT NOT NULL, user_id TEXT NOT NULL, model TEXT NOT NULL, requests BIGINT NOT NULL, input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL, cached_tokens BIGINT NOT NULL, cost_micros BIGINT NOT NULL, first_at BIGINT NOT NULL, last_at BIGINT NOT NULL, PRIMARY KEY(server,user_id,model));
      CREATE TABLE IF NOT EXISTS reply_runs (server TEXT NOT NULL, message_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(server,message_id,run_id));
      CREATE TABLE IF NOT EXISTS conversation_events (
        stream_id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL, channel TEXT NOT NULL,
        kind TEXT NOT NULL, ref TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_events_channel ON conversation_events(server,channel,stream_id);
      CREATE INDEX IF NOT EXISTS conversation_events_created ON conversation_events(created_at);
      CREATE INDEX IF NOT EXISTS runs_channel ON runs(json_extract(message,'$.server'),json_extract(message,'$.channel'));
      CREATE TABLE IF NOT EXISTS web_webhooks (server TEXT NOT NULL, channel TEXT NOT NULL, webhook_id TEXT NOT NULL, token_encrypted TEXT NOT NULL, PRIMARY KEY(server,channel));
      CREATE INDEX IF NOT EXISTS web_webhooks_hook ON web_webhooks(server,webhook_id);
      CREATE TABLE IF NOT EXISTS web_replies (id TEXT PRIMARY KEY, server TEXT NOT NULL, channel TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT, created_at INTEGER NOT NULL, via TEXT NOT NULL DEFAULT 'webhook');
      CREATE INDEX IF NOT EXISTS web_replies_message ON web_replies(server,message_id);
      CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, server TEXT NOT NULL, channel TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS shares_server ON shares(server,created_at);
      CREATE TABLE IF NOT EXISTS web_sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS web_sessions_expires ON web_sessions(expires);
      CREATE TABLE IF NOT EXISTS web_chats (id TEXT PRIMARY KEY, server TEXT NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS web_chats_owner ON web_chats(server,owner,updated);
      CREATE TABLE IF NOT EXISTS web_provider_keys (id TEXT PRIMARY KEY, provider TEXT NOT NULL, owner TEXT NOT NULL, label TEXT NOT NULL, last4 TEXT NOT NULL, secret_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS web_provider_usage (key_id TEXT NOT NULL, month TEXT NOT NULL, used INTEGER NOT NULL, exhausted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(key_id, month));
      CREATE TABLE IF NOT EXISTS inbox_items (id TEXT PRIMARY KEY, server TEXT NOT NULL, target TEXT NOT NULL, sender TEXT NOT NULL, channel TEXT NOT NULL, source_ids TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, done_at INTEGER);
      CREATE INDEX IF NOT EXISTS inbox_items_target ON inbox_items(server,target,done_at,created_at);
      CREATE INDEX IF NOT EXISTS inbox_items_sender ON inbox_items(server,sender,created_at);
    `);
    if (!this.db.prepare("PRAGMA table_info(web_replies)").all().some(column => column.name === "via")) this.db.exec("ALTER TABLE web_replies ADD COLUMN via TEXT NOT NULL DEFAULT 'webhook'");
    if (!this.db.prepare("PRAGMA table_info(web_chats)").all().some(column => column.name === "effort")) this.db.exec("ALTER TABLE web_chats ADD COLUMN effort TEXT");
    const operationColumns = this.db.prepare("PRAGMA table_info(tool_operations)").all();
    if (!operationColumns.some(column => column.name === "resource")) this.db.exec("ALTER TABLE tool_operations ADD COLUMN resource TEXT");
    const jobColumns = this.db.prepare("PRAGMA table_info(jobs)").all();
    if (!jobColumns.some(column => column.name === "available_at")) this.db.exec("ALTER TABLE jobs ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0");
    const threadColumns = this.db.prepare("PRAGMA table_info(task_threads)").all();
    if (!threadColumns.some(column => column.name === "source_id")) this.db.exec("ALTER TABLE task_threads ADD COLUMN source_id TEXT");
    const runColumns = this.db.prepare("PRAGMA table_info(runs)").all();
    if (!runColumns.some(column => column.name === "context_version")) this.db.exec("ALTER TABLE runs ADD COLUMN context_version INTEGER NOT NULL DEFAULT 0");
    if (!this.db.prepare("PRAGMA table_info(author_directory)").all().some(column => column.name === "identity")) this.db.exec("ALTER TABLE author_directory ADD COLUMN identity TEXT NOT NULL DEFAULT '{}'");
    this.mergeUserLimits(Date.now());
    const columns = this.db.prepare("PRAGMA table_info(task_history)").all();
    if (!columns.some(column => column.name === "valid")) {
      this.db.exec("ALTER TABLE task_history ADD COLUMN valid INTEGER NOT NULL DEFAULT 1");
    }
  }

  /** Usage limits are shared by one user across all servers (scope 'global'). Merges old rows for each server once: sum spent of running windows (earliest start), sum banked resets. */
  private mergeUserLimits(now: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO user_limit_counters(server,user_id,kind,window_start,spent)
        SELECT 'global', user_id, kind, MIN(window_start), SUM(spent) FROM user_limit_counters
        WHERE server<>'global' AND window_start + CASE kind WHEN '5h' THEN 18000000 ELSE 604800000 END > ?
        GROUP BY user_id, kind
        ON CONFLICT(server,user_id,kind) DO UPDATE SET window_start=MIN(user_limit_counters.window_start,excluded.window_start), spent=user_limit_counters.spent+excluded.spent`).run(now);
      this.db.prepare("DELETE FROM user_limit_counters WHERE server<>'global'").run();
      this.db.prepare(`INSERT INTO user_limit_resets(server,user_id,kind,count)
        SELECT 'global', user_id, kind, SUM(count) FROM user_limit_resets WHERE server<>'global' GROUP BY user_id, kind
        ON CONFLICT(server,user_id,kind) DO UPDATE SET count=user_limit_resets.count+excluded.count`).run();
      this.db.prepare("DELETE FROM user_limit_resets WHERE server<>'global'").run();
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private namedMessage(message: Message): Message {
    const row = this.db.prepare("SELECT names,bot FROM author_directory WHERE server=? AND author=?").get(message.server,message.author);
    return row ? { ...message, authorName: (JSON.parse(String(row.names)) as string[])[0] ?? message.author, isBot: Boolean(row.bot) } : message;
  }
  profile(server: string, user: string): UserProfile {
    const identity = this.db.prepare("SELECT names,identity FROM author_directory WHERE server=? AND author=?").get(server,user);
    const lock = this.db.prepare("SELECT allow_edits FROM profile_locks WHERE server=? AND user_id=?").get(server,user);
    const rows = this.db.prepare(`SELECT e.* FROM profile_current c JOIN profile_events e ON e.id=c.event_id WHERE c.server=? AND c.user_id=? AND e.valid=1 AND e.value<>'null' ORDER BY c.field`).all(server,user);
    return { userId: user, name: identity ? JSON.parse(String(identity.names))[0] : user, identity: identity ? JSON.parse(String(identity.identity)) : {}, allowEdits: lock ? Boolean(lock.allow_edits) : true, fields: rows.map(row => this.profileField(row)) };
  }
  private profileField(row: Record<string, unknown>): ProfileField {
    return { field: String(row.field), value: JSON.parse(String(row.value)) as Json, editor: String(row.editor), sourceIds: JSON.parse(String(row.sources)) as string[], revision: String(row.id) };
  }
  findPeople(server: string, query: string): { id: string; name: string }[] {
    const id = query.match(/^<@!?(\d+)>$/)?.[1] ?? (/^\d+$/.test(query) ? query : undefined);
    return this.knownAuthors(server).flatMap(({author}) => {
      const profile = this.profile(server,author), row = this.db.prepare("SELECT names FROM author_directory WHERE server=? AND author=?").get(server,author);
      const names = [...(row ? JSON.parse(String(row.names)) as string[] : []), ...profile.fields.filter(item => ["real_name","nickname","nicknames","aliases"].includes(item.field)).flatMap(item => typeof item.value === "string" ? [item.value] : Array.isArray(item.value) ? item.value.filter((value): value is string => typeof value === "string") : [])];
      return (id ? id === author : names.some(name => name.toLowerCase() === query.trim().toLowerCase())) ? [{id:author,name:profile.name}] : [];
    });
  }
  editProfile(message: Message, user: string, field: string, value: Json, operation: string, sources = [message.id]): string {
    if (this.db.prepare("SELECT 1 FROM profile_events WHERE id=?").get(operation)) return "Profile change already recorded.";
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(field) || field.startsWith("discord_") || ["server_name","server_nickname","display_name"].includes(field)) throw new ToolError("Use a custom field name; automatic Discord identity is read-only.");
    if (user !== message.author && !this.profile(message.server,user).allowEdits) throw new ToolError("The profile owner has disabled edits by other members.");
    if (!this.canonicalMessage(message.server,message.id)) throw new ToolError("Profile changes require a stored source message.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO profile_events(id,server,user_id,field,value,editor,sources) VALUES(?,?,?,?,?,?,?)").run(operation,message.server,user,field,JSON.stringify(value),message.author,JSON.stringify(sources));
      this.db.prepare("INSERT INTO profile_current VALUES(?,?,?,?) ON CONFLICT(server,user_id,field) DO UPDATE SET event_id=excluded.event_id").run(message.server,user,field,operation);
      this.db.prepare("UPDATE context_versions SET version=version+1 WHERE server=?").run(message.server);
      this.db.exec("COMMIT");
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
    return `Profile ${field} ${value === null ? "removed" : "updated"}; revision ${operation}.`;
  }
  lockProfile(server: string,user: string,actor: string,allow: boolean): void {
    if (user !== actor) throw new ToolError("Only the profile owner may change edit permissions.");
    this.db.prepare("INSERT INTO profile_locks VALUES(?,?,?) ON CONFLICT(server,user_id) DO UPDATE SET allow_edits=excluded.allow_edits").run(server,user,allow?1:0);
  }
  profileHistory(server: string,user: string,actor: string): ProfileField[] {
    if (user !== actor) throw new ToolError("Only the profile owner may inspect edit history.");
    return this.db.prepare("SELECT * FROM profile_events WHERE server=? AND user_id=? AND valid=1 ORDER BY sequence DESC LIMIT 50").all(server,user).map(row=>this.profileField(row));
  }
  undoProfile(message: Message,user: string,revision: string,operation: string): string {
    if (user !== message.author) throw new ToolError("Only the profile owner may undo changes.");
    if (this.db.prepare("SELECT 1 FROM profile_events WHERE id=?").get(operation)) return "Profile undo already recorded.";
    const event = this.db.prepare("SELECT * FROM profile_events WHERE id=? AND server=? AND user_id=? AND valid=1").get(revision,message.server,user);
    if (!event) throw new ToolError("Unknown or invalidated revision.");
    const current = this.db.prepare("SELECT event_id FROM profile_current WHERE server=? AND user_id=? AND field=?").get(message.server,user,String(event.field));
    if (current?.event_id !== revision) throw new ToolError("A newer edit exists. Undo the current revision first.");
    const previous = this.db.prepare("SELECT * FROM profile_events WHERE server=? AND user_id=? AND field=? AND sequence<? AND valid=1 ORDER BY sequence DESC LIMIT 1").get(message.server,user,String(event.field),Number(event.sequence));
    return this.editProfile(message,user,String(event.field),previous ? JSON.parse(String(previous.value)) as Json : null,operation,[message.id,...(previous ? JSON.parse(String(previous.sources)) as string[] : [])]);
  }
  knownAuthors(server: string): { author: string; named: boolean }[] {
    return this.db.prepare(`SELECT DISTINCT json_extract(m.body,'$.author') AS author, d.author AS named FROM messages m
      LEFT JOIN author_directory d ON d.server=m.server AND d.author=json_extract(m.body,'$.author') WHERE m.server=? AND m.channel NOT LIKE 'web:%'`).all(server)
      .map(row => ({ author: String(row.author), named: row.named !== null }));
  }
  identifyAuthor(server: string, author: string, names: readonly string[], bot = false, identity: Record<string, string> = {}): void {
    const previous = this.db.prepare("SELECT names,identity FROM author_directory WHERE server=? AND author=?").get(server, author);
    const aliases = [...new Set([...names, ...(previous ? JSON.parse(String(previous.names)) as string[] : [])])].filter(Boolean).slice(0, 20);
    this.db.prepare("INSERT INTO author_directory(server,author,names,bot,identity) VALUES(?,?,?,?,?) ON CONFLICT(server,author) DO UPDATE SET names=excluded.names,bot=excluded.bot,identity=excluded.identity")
      .run(server, author, JSON.stringify(aliases), bot ? 1 : 0, JSON.stringify({ ...(previous ? JSON.parse(String(previous.identity)) : {}), ...identity }));
  }
  async ingest(message: Message): Promise<boolean> {
    if (message.transient) { await this.removeTransient(message.server, message.channel, message.id); return false; }
    if (this.db.prepare("SELECT 1 FROM message_tombstones WHERE server=? AND id=?").get(message.server, message.id)) return false;
    const previous = await this.canonicalMessage(message.server, message.id);
    if (previous && message.revisionTimestamp !== undefined && message.revisionTimestamp > (previous.revisionTimestamp ?? previous.timestamp ?? 0)) { await this.revise(message); return false; }
    if (message.authorName) this.identifyAuthor(message.server, message.author, [message.authorName, ...(message.authorAliases ?? [])], message.isBot, message.authorIdentity);
    const result = this.db.prepare(
      "INSERT OR IGNORE INTO messages(server,id,channel,body) VALUES(?,?,?,?)",
    ).run(message.server, message.id, message.channel, JSON.stringify(message));
    return result.changes === 1;
  }

  async context(message: Message, limit: number): Promise<readonly Message[]> {
    const current = this.db.prepare("SELECT coalesce(json_extract(body,'$.timestamp'),sequence) AS moment FROM messages WHERE server=? AND id=?")
      .get(message.server, message.id);
    if (!current) throw new Error("Message was not ingested");
    const rows = this.db.prepare(
      "SELECT body FROM messages WHERE server=? AND channel=? AND coalesce(json_extract(body,'$.timestamp'),sequence)<? ORDER BY coalesce(json_extract(body,'$.timestamp'),sequence) DESC LIMIT ?",
    ).all(message.server, message.channel, current.moment!, limit);
    const selected = rows.reverse().map(row => this.namedMessage(parseMessage(JSON.parse(String(row.body)))));
    const seen = new Set(selected.map(item => item.id));
    let reference = message.replyTo;
    const visited = new Set<string>();
    for (let count = 0; reference && count < 4; count++) {
      if (visited.has(reference)) break;
      visited.add(reference);
      const row = this.db.prepare("SELECT body FROM messages WHERE server=? AND channel=? AND id=?")
        .get(message.server, message.channel, reference);
      if (!row) break;
      const item = this.namedMessage(parseMessage(JSON.parse(String(row.body))));
      if (!seen.has(item.id)) selected.unshift(item);
      seen.add(item.id);
      reference = item.replyTo;
    }
    return selected;
  }

  async history(taskKey: string): Promise<readonly PromptItem[]> {
    const context = await this.taskContext(taskKey);
    return [...(context.checkpoint ? [context.checkpoint] : []), ...context.entries.map(entry => entry.item)];
  }

  historyArchive(taskKey: string): PromptItem[] {
    return this.db.prepare("SELECT item FROM task_history WHERE task_key=? ORDER BY sequence").all(taskKey).map(row => JSON.parse(String(row.item)) as PromptItem);
  }

  async taskContext(taskKey: string): Promise<TaskContext> {
    const saved = this.db.prepare("SELECT * FROM task_checkpoints WHERE task_key=? AND valid=1 ORDER BY sequence DESC LIMIT 1").get(taskKey);
    const entries = this.db.prepare("SELECT sequence,item FROM task_history WHERE task_key=? AND valid=1 AND sequence>? ORDER BY sequence")
      .all(taskKey, saved ? Number(saved.through_sequence) : 0).map(row => ({ sequence: Number(row.sequence), item: JSON.parse(String(row.item)) as PromptItem }));
    return { checkpoint: saved ? JSON.parse(String(saved.item)) as PromptItem : null, entries };
  }

  async checkpoint(taskKey: string, through: number, item: PromptItem, runId: string): Promise<void> {
    this.db.prepare("INSERT INTO task_checkpoints(task_key,through_sequence,item,run_id) VALUES(?,?,?,?)").run(taskKey, through, JSON.stringify(item), runId);
  }

  async finishToolRun(runId: string, text: string): Promise<void> {
    this.db.prepare("UPDATE runs SET status='tool_calls',result=? WHERE id=?").run(text, runId);
  }

  lastContextChange(server: string, channel: string): unknown {
    const row = this.db.prepare("SELECT value FROM settings WHERE server=? AND key=?").get(server, `context_change:${channel}`);
    return row ? JSON.parse(String(row.value)) : undefined;
  }

  agentTurns(message: Message): AgentTurn[] {
    if (this.db.prepare("SELECT 1 FROM agent_turns WHERE server=? AND message_id=? AND valid=0").get(message.server, message.id)) throw contextChangedError(message, this.lastContextChange(message.server, message.channel));
    return this.db.prepare("SELECT * FROM agent_turns WHERE server=? AND message_id=? AND valid=1 ORDER BY sequence")
      .all(message.server, message.id).map(row => ({ id: String(row.id), text: String(row.text), calls: JSON.parse(String(row.calls)), results: JSON.parse(String(row.results)), version: Number(row.version) }));
  }
  addAgentTurn(message: Message, text: string, calls: ToolCall[]): AgentTurn {
    const version = Number(this.db.prepare("SELECT version FROM context_versions WHERE server=? AND channel=?").get(message.server, message.channel)?.version ?? 0);
    const turn: AgentTurn = { id: randomUUID(), text, calls, results: {}, version };
    this.db.prepare("INSERT INTO agent_turns(id,server,message_id,text,calls,results,version) VALUES(?,?,?,?,?,?,?)")
      .run(turn.id, message.server, message.id, text, JSON.stringify(calls), "{}", version);
    return turn;
  }
  agentResult(turnId: string, index: number, result: ToolOutput): void {
    this.db.prepare("UPDATE agent_turns SET results=json_set(results,?,json(?)) WHERE id=?").run(`$."${index}"`, JSON.stringify(result), turnId);
    const turn = this.db.prepare("SELECT server,message_id FROM agent_turns WHERE id=?").get(turnId)!;
    const version = this.db.prepare(`SELECT coalesce(v.version,0) AS version FROM messages m LEFT JOIN context_versions v ON v.server=m.server AND v.channel=m.channel WHERE m.server=? AND m.id=?`).get(turn.server!, turn.message_id!);
    if (version) this.db.prepare("UPDATE agent_turns SET version=? WHERE server=? AND message_id=? AND valid=1").run(Number(version.version), turn.server!, turn.message_id!);
  }

  async partialReply(message: Message): Promise<string | undefined> {
    const run = this.db.prepare(`SELECT id FROM runs WHERE status IN ('failed','interrupted') AND json_extract(message,'$.server')=?
      AND json_extract(message,'$.id')=? AND json_extract(message,'$.text')=? AND json_extract(message,'$.author')=?
      AND json_extract(prompt,'$.purpose')='reply' AND context_version=? ORDER BY rowid DESC LIMIT 1`)
      .get(message.server, message.id, message.text, message.author, await this.contextVersion(message.server, message.channel));
    if (!run) return undefined;
    return this.db.prepare("SELECT payload FROM events WHERE run_id=? AND kind='text' ORDER BY sequence").all(run.id!)
      .map(row => String(JSON.parse(String(row.payload)).text)).join("") || undefined;
  }
  async recordHarness(message: { server: string; id: string }, state: HarnessState, event: HarnessEvent): Promise<void> {
    this.db.prepare("INSERT INTO harness_events(server,message_id,state,event) VALUES(?,?,?,?)").run(message.server, message.id, JSON.stringify(state), JSON.stringify(event));
  }
  async harnessState(server: string, id: string): Promise<HarnessState | undefined> {
    const row = this.db.prepare("SELECT state FROM harness_events WHERE server=? AND message_id=? ORDER BY sequence DESC LIMIT 1").get(server, id);
    return row ? JSON.parse(String(row.state)) as HarnessState : undefined;
  }
  async shareMessages(server: string, channel: string, range: ShareMessageRange): Promise<ShareMessageResult> { return shareMessages(this.db, server, channel, range); }
  async shareRequestEvents(server: string, requests: readonly string[]) { return shareRequestEvents(this.db, server, requests); }
  async insertShare(row: ShareRow): Promise<void> { return insertShare(this.db, row); }
  async getShare(id: string): Promise<ShareRow | undefined> { return getShare(this.db, id); }
  async listShares(server: string, limit: number) { return listShares(this.db, server, limit); }
  async listChatShares(server: string, channel: string, limit: number) { return listChatShares(this.db, server, channel, limit); }
  async revokeShare(server: string, id: string, at: number): Promise<boolean> { return revokeShare(this.db, server, id, at); }
  async revokeAllShares(server: string, at: number): Promise<number> { return revokeAllShares(this.db, server, at); }
  async deleteChatShares(channel: string): Promise<number> { return deleteChatShares(this.db, channel); }
  async getSession(idHash: string): Promise<WebSessionRow | undefined> { return getWebSession(this.db, idHash); }
  async insertWebChat(row: WebChatRow): Promise<void> { return insertWebChat(this.db, row); }
  async webChat(id: string): Promise<WebChatRow | undefined> { return getWebChat(this.db, id); }
  async webChats(owner: string): Promise<WebChatRow[]> { return listWebChats(this.db, owner); }
  async liveWebChatChannels(server: string): Promise<string[]> { return liveWebChatChannels(this.db, server); }
  async renameWebChat(id: string, title: string, updated: number): Promise<void> { return renameWebChat(this.db, id, title, updated); }
  async setWebChatEffort(id: string, effort: Effort | null): Promise<void> { return setWebChatEffort(this.db, id, effort); }
  async touchWebChat(id: string, updated: number): Promise<void> { return touchWebChat(this.db, id, updated); }
  /** Deletes a private chat: its runs, events and queue rows, then its messages. The row stays, marked deleted. */
  async deleteWebChat(id: string, server: string, channel: string, at: number): Promise<void> {
    await markWebChatDeleted(this.db, id, at);
    await deleteChatRows(this.db, server, channel);
    for (const row of this.db.prepare("SELECT id FROM messages WHERE server=? AND channel=?").all(server, channel)) this.invalidateSource(server, String(row.id));
    this.db.prepare("DELETE FROM messages WHERE server=? AND channel=?").run(server, channel);
    this.invalidate(server, channel, { reason: "channel_disabled" });
    this.db.prepare("DELETE FROM settings WHERE server=? AND key=?").run(server, `context_change:${channel}`);
  }
  async saveSession(row: WebSessionRow): Promise<void> { return saveWebSession(this.db, row); }
  async deleteSession(idHash: string): Promise<void> { return deleteWebSession(this.db, idHash); }
  async deleteExpiredSessions(now: number): Promise<number> { return deleteExpiredWebSessions(this.db, now); }
  async addInboxItem(item: InboxItem): Promise<void> {
    this.db.prepare("INSERT INTO inbox_items (id,server,target,sender,channel,source_ids,summary,created_at,done_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(item.id, item.server, item.target, item.sender, item.channel, JSON.stringify(item.sourceIds), item.summary, item.created_at, item.done_at);
  }
  async inboxItems(server: string, target: string, options: { includeDone: boolean; limit: number }): Promise<InboxItem[]> {
    const open = options.includeDone ? "" : " AND done_at IS NULL";
    return this.db.prepare(`SELECT id,server,target,sender,channel,source_ids,summary,created_at,done_at FROM inbox_items WHERE server=? AND target=?${open} ORDER BY created_at DESC LIMIT ?`)
      .all(server, target, options.limit).map(inboxItemFromRow);
  }
  async markInboxDone(server: string, target: string, ids: string[] | "all", at: number): Promise<number> {
    if (ids !== "all" && ids.length === 0) return 0;
    const scope = ids === "all" ? "" : ` AND id IN (${ids.map(() => "?").join(",")})`;
    const values = ids === "all" ? [] : ids;
    return Number(this.db.prepare(`UPDATE inbox_items SET done_at=? WHERE server=? AND target=? AND done_at IS NULL${scope}`).run(at, server, target, ...values).changes);
  }
  async countInboxSent(server: string, sender: string, since: number): Promise<number> {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE server=? AND sender=? AND created_at>=?").get(server, sender, since)!.n);
  }
  async deleteExpiredInbox(before: number): Promise<number> {
    return Number(this.db.prepare("DELETE FROM inbox_items WHERE created_at<?").run(before).changes);
  }
  async startRun(runId: string, message: Message, prompt: Prompt): Promise<void> {
    this.db.prepare("INSERT INTO runs(id,message,prompt,status,result,context_version) VALUES(?,?,?,?,NULL,?)")
      .run(runId, JSON.stringify(message), JSON.stringify(prompt), "running", await this.contextVersion(message.server, message.channel));
    await saveRunRuntime(this, message.server, runId);
  }

  async appendEvent(runId: string, sequence: number, event: ModelEvent): Promise<void> {
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)")
      .run(runId, sequence, event.kind, JSON.stringify(event.payload));
  }
  async appendEvents(runId: string, startSequence: number, events: readonly ModelEvent[]): Promise<void> {
    if (!events.length) return;
    const rows = events.map(() => "(?,?,?,?)").join(",");
    this.db.prepare(`INSERT INTO events VALUES ${rows}`).run(...events.flatMap((event, index) => [runId, startSequence + index, event.kind, JSON.stringify(event.payload)]));
  }

  async complete(runId: string, taskKey: string | undefined, inputs: readonly PromptItem[], text: string): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (taskKey) {
        const insert = this.db.prepare("INSERT INTO task_history(task_key,item) VALUES(?,?)");
        for (const item of [...inputs, { role: "assistant", content: text }]) {
          insert.run(taskKey, JSON.stringify(item));
        }
      }
      this.db.prepare("UPDATE runs SET status='completed',result=? WHERE id=?").run(text, runId);
      const run = this.db.prepare("SELECT message,prompt,context_version FROM runs WHERE id=?").get(runId)!;
      const message = parseMessage(JSON.parse(String(run.message)));
      if ([undefined, "reply"].includes(JSON.parse(String(run.prompt)).purpose)) {
        this.db.prepare("UPDATE jobs SET status='sending',reply=? WHERE server=? AND message_id=? AND status='running'")
          .run(JSON.stringify({ runId, text, contextVersion: Number(run.context_version) }), message.server, message.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async fail(runId: string, error: string): Promise<void> {
    this.db.prepare("UPDATE runs SET status='failed',result=? WHERE id=?").run(error, runId);
  }

  llmUsage(server: string): { requests: number; input: number; output: number; cached: number } {
    const row = this.db.prepare(`SELECT count(*) AS requests,coalesce(sum(json_extract(e.payload,'$.prompt_tokens')),0) AS input,
      coalesce(sum(json_extract(e.payload,'$.completion_tokens')),0) AS output,
      coalesce(sum(json_extract(e.payload,'$.prompt_tokens_details.cached_tokens')),0) AS cached
      FROM events e JOIN runs r ON r.id=e.run_id WHERE e.kind='usage' AND json_extract(r.message,'$.server')=?`).get(server)!;
    return { requests: Number(row.requests), input: Number(row.input), output: Number(row.output), cached: Number(row.cached) };
  }

  canonicalMessage(server: string, id: string): Message | undefined {
    const row = this.db.prepare("SELECT body FROM messages WHERE server=? AND id=?").get(server, id);
    return row ? parseMessage(JSON.parse(String(row.body))) : undefined;
  }

  events(runId: string): ModelEvent[] {
    return this.db.prepare("SELECT kind,payload FROM events WHERE run_id=? ORDER BY sequence")
      .all(runId).map(row => ({ kind: row.kind, payload: JSON.parse(String(row.payload)) }) as ModelEvent);
  }

  // Web transcripts (read-only views and the live event store).
  async conversationActivity(server: string): Promise<{ channel: string; newest: number }[]> {
    return this.db.prepare("SELECT channel, MAX(COALESCE(json_extract(body,'$.timestamp'),0)) AS newest FROM messages WHERE server=? AND channel NOT LIKE 'web:%' GROUP BY channel")
      .all(server).map(row => ({ channel: String(row.channel), newest: Number(row.newest) }));
  }
  async conversationMessages(server: string, channel: string, before: { time: number; id: string } | undefined, limit: number): Promise<Message[]> {
    const rows = before
      ? this.db.prepare("SELECT body FROM messages WHERE server=? AND channel=? AND (COALESCE(json_extract(body,'$.timestamp'),0)<? OR (COALESCE(json_extract(body,'$.timestamp'),0)=? AND id<?)) ORDER BY COALESCE(json_extract(body,'$.timestamp'),0) DESC,id DESC LIMIT ?")
        .all(server, channel, before.time, before.time, before.id, limit)
      : this.db.prepare("SELECT body FROM messages WHERE server=? AND channel=? ORDER BY COALESCE(json_extract(body,'$.timestamp'),0) DESC,id DESC LIMIT ?")
        .all(server, channel, limit);
    return rows.map(row => this.namedMessage(parseMessage(JSON.parse(String(row.body)))));
  }
  // The messages of one channel that a reply run used. Participation runs are not reply runs, so they do not count.
  async usedSourceIds(server: string, channel: string, messageIds: readonly string[]): Promise<string[]> {
    if (!messageIds.length) return [];
    const marks = messageIds.map(() => "?").join(",");
    return this.db.prepare(`SELECT DISTINCT s.message_id FROM run_sources s JOIN messages m ON m.server=s.server AND m.id=s.message_id
      WHERE s.server=? AND m.channel=? AND s.message_id IN (${marks}) AND s.run_id IN (SELECT run_id FROM reply_runs WHERE server=?)`)
      .all(server, channel, ...messageIds, server).map(row => String(row.message_id));
  }
  // Conversations (see conversation-groups.ts). Reply runs only; participation runs are not conversations.
  async channelRuns(server: string, channel: string): Promise<ChannelRun[]> {
    // Only prompts with purpose reply. Participation classifier runs have no purpose, so they are not conversations.
    return this.db.prepare("SELECT id,message,status FROM runs WHERE json_extract(message,'$.server')=? AND json_extract(message,'$.channel')=? AND json_extract(prompt,'$.purpose')='reply' ORDER BY rowid")
      .all(server, channel).map(row => ({ id: String(row.id), message: parseMessage(JSON.parse(String(row.message))), status: String(row.status) }));
  }
  async channelReplies(server: string, channel: string): Promise<ChannelReply[]> {
    return this.db.prepare("SELECT rr.message_id,rr.run_id,json_extract(m.body,'$.timestamp') AS ts FROM reply_runs rr JOIN messages m ON m.server=rr.server AND m.id=rr.message_id WHERE rr.server=? AND m.channel=?")
      .all(server, channel).map(row => ({ messageId: String(row.message_id), runId: String(row.run_id), timestamp: row.ts === null ? null : Number(row.ts) }));
  }
  async channelSources(server: string, channel: string): Promise<RunSource[]> {
    return this.db.prepare("SELECT s.run_id,s.message_id FROM runs r JOIN run_sources s ON s.run_id=r.id JOIN messages m ON m.server=s.server AND m.id=s.message_id WHERE json_extract(r.message,'$.server')=? AND json_extract(r.message,'$.channel')=? AND m.channel=?")
      .all(server, channel, channel).map(row => ({ runId: String(row.run_id), messageId: String(row.message_id) }));
  }
  async messagesById(server: string, channel: string, ids: readonly string[]): Promise<Message[]> {
    const found: Message[] = [];
    for (let start = 0; start < ids.length; start += 500) {
      const part = ids.slice(start, start + 500);
      const marks = part.map(() => "?").join(",");
      for (const row of this.db.prepare(`SELECT body FROM messages WHERE server=? AND channel=? AND id IN (${marks})`).all(server, channel, ...part))
        found.push(this.namedMessage(parseMessage(JSON.parse(String(row.body)))));
    }
    return found.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  async replyRunIds(server: string, messageId: string): Promise<string[]> {
    return this.db.prepare("SELECT r.run_id FROM reply_runs r LEFT JOIN runs u ON u.id=r.run_id WHERE r.server=? AND r.message_id=? ORDER BY u.rowid").all(server, messageId).map(row => String(row.run_id));
  }
  async requestRunIds(server: string, requestId: string): Promise<string[]> {
    return this.db.prepare("SELECT id FROM runs WHERE json_extract(message,'$.server')=? AND json_extract(message,'$.id')=? AND COALESCE(json_extract(prompt,'$.purpose'),'reply')='reply' ORDER BY rowid")
      .all(server, requestId).map(row => String(row.id));
  }
  async runRecord(runId: string): Promise<import('../web-transcripts.js').TranscriptRun | undefined> {
    const row = this.db.prepare("SELECT id,message,prompt,status,result FROM runs WHERE id=?").get(runId);
    if (!row) return undefined;
    return { id: String(row.id), message: parseMessage(JSON.parse(String(row.message))), purpose: String(JSON.parse(String(row.prompt)).purpose ?? "reply"), status: String(row.status), result: row.result === null ? null : String(row.result), context: promptInventory(JSON.parse(String(row.prompt))) };
  }
  async toolTurns(server: string, messageId: string): Promise<{ calls: ToolCall[]; results: Record<string, ToolOutput> }[]> {
    return this.db.prepare("SELECT calls,results FROM agent_turns WHERE server=? AND message_id=? AND valid=1 ORDER BY sequence")
      .all(server, messageId).map(row => ({ calls: JSON.parse(String(row.calls)), results: JSON.parse(String(row.results)) }));
  }
  async appendConversationEvent(row: { server: string; channel: string; kind: string; ref: string; data: Json; createdAt: number }): Promise<number> {
    const saved = this.db.prepare("INSERT INTO conversation_events(server,channel,kind,ref,data,created_at) VALUES(?,?,?,?,?,?) RETURNING stream_id")
      .get(row.server, row.channel, row.kind, row.ref, JSON.stringify(row.data), row.createdAt)!;
    return Number(saved.stream_id);
  }
  async latestStreamId(server: string, channel: string): Promise<number> {
    return Number(this.db.prepare("SELECT COALESCE(MAX(stream_id),0) AS id FROM conversation_events WHERE server=? AND channel=?").get(server, channel)!.id);
  }
  async conversationEventsAfter(server: string, channel: string, after: number, limit: number): Promise<ConversationEvent[]> {
    return this.db.prepare("SELECT stream_id,server,channel,kind,ref,data,created_at FROM conversation_events WHERE server=? AND channel=? AND stream_id>? ORDER BY stream_id LIMIT ?")
      .all(server, channel, after, limit).map(row => ({ streamId: Number(row.stream_id), server: String(row.server), channel: String(row.channel), kind: String(row.kind) as ConversationEvent["kind"], ref: String(row.ref), data: JSON.parse(String(row.data)) as Json, createdAt: Number(row.created_at) }));
  }
  async oldestStreamId(server: string, channel: string): Promise<number | undefined> {
    const row = this.db.prepare("SELECT MIN(stream_id) AS id FROM conversation_events WHERE server=? AND channel=?").get(server, channel)!;
    return row.id === null ? undefined : Number(row.id);
  }
  /** Deletes rows older than olderThan, then the oldest rows beyond maxRows. Each statement deletes at most CONVERSATION_PRUNE_BATCH rows. */
  async pruneConversationEvents(olderThan: number, maxRows: number): Promise<number> {
    let deleted = 0;
    for (;;) {
      const changes = Number(this.db.prepare("DELETE FROM conversation_events WHERE stream_id IN (SELECT stream_id FROM conversation_events WHERE created_at<? LIMIT ?)").run(olderThan, CONVERSATION_PRUNE_BATCH).changes);
      deleted += changes;
      if (changes < CONVERSATION_PRUNE_BATCH) break;
    }
    let excess = Number(this.db.prepare("SELECT COUNT(*) AS n FROM conversation_events").get()!.n) - maxRows;
    while (excess > 0) {
      const changes = Number(this.db.prepare("DELETE FROM conversation_events WHERE stream_id IN (SELECT stream_id FROM conversation_events ORDER BY stream_id LIMIT ?)").run(Math.min(excess, CONVERSATION_PRUNE_BATCH)).changes);
      if (!changes) break;
      deleted += changes;
      excess -= changes;
    }
    return deleted;
  }

  close(): void { this.db.close(); }

  async finishIndexing(): Promise<void> { await this.indexTail; }

  private job(row: Record<string, unknown>): Job {
    return { id: String(row.id), message: parseMessage(JSON.parse(String(row.message))), status: row.status as Job["status"], reply: row.reply ? JSON.parse(String(row.reply)) : null, attempts: Number(row.attempts), error: row.error === null ? null : String(row.error) };
  }
  enqueueJob(message: Message): Job {
    if (message.authorName) this.identifyAuthor(message.server, message.author, [message.authorName, ...(message.authorAliases ?? [])], message.isBot, message.authorIdentity);
    if (this.db.prepare("SELECT 1 FROM message_tombstones WHERE server=? AND id=?").get(message.server, message.id)) throw contextChangedError(message, { reason: "message_deleted", sourceId: message.id });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO messages(server,id,channel,body) VALUES(?,?,?,?)").run(message.server, message.id, message.channel, JSON.stringify(message));
      this.db.prepare("INSERT OR IGNORE INTO jobs(id,server,channel,message_id,message,status) VALUES(?,?,?,?,?,'pending')").run(randomUUID(), message.server, message.channel, message.id, JSON.stringify(message));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.job(this.db.prepare("SELECT * FROM jobs WHERE server=? AND message_id=?").get(message.server, message.id)!);
  }
  acquireWorker(server: string, owner: string, expires: number): boolean {
    const result = this.db.prepare(`INSERT INTO worker_leases VALUES(?,?,?) ON CONFLICT(server) DO UPDATE SET owner=excluded.owner,expires=excluded.expires
      WHERE worker_leases.owner=excluded.owner OR worker_leases.expires<?`).run(server, owner, expires, Date.now());
    return result.changes === 1;
  }
  releaseWorker(server: string, owner: string): void { this.db.prepare("DELETE FROM worker_leases WHERE server=? AND owner=?").run(server, owner); }
  recoverJobs(server: string): void {
    this.db.prepare("UPDATE runs SET status='interrupted' WHERE status='running' AND json_extract(message,'$.server')=?").run(server);
    this.db.prepare("UPDATE jobs SET status=CASE WHEN reply IS NULL THEN 'pending' ELSE 'ready' END WHERE server=? AND status IN ('running','sending')").run(server);
  }
  claimJob(server: string): Job | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT * FROM jobs j WHERE server=? AND status IN ('pending','ready') AND available_at<=? AND NOT EXISTS
        (SELECT 1 FROM jobs active WHERE active.server=j.server AND active.channel=j.channel AND active.id<>j.id AND
          (active.status IN ('running','sending') OR (active.status IN ('pending','ready') AND active.sequence<j.sequence))) ORDER BY sequence LIMIT 1`).get(server, Date.now());
      if (row) this.db.prepare("UPDATE jobs SET status=?,attempts=attempts+1 WHERE id=?").run(row.reply ? "sending" : "running", row.id!);
      this.db.exec("COMMIT");
      return row ? this.job(row) : undefined;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  readyJob(id: string, reply: import("../domain.js").Reply): void { this.db.prepare("UPDATE jobs SET status='sending',reply=? WHERE id=? AND status='running'").run(JSON.stringify(reply), id); }
  finishJob(id: string): void { this.db.prepare("UPDATE jobs SET status='done',error=NULL WHERE id=? AND status<>'cancelled'").run(id); }
  retryLater(id: string, at: number): void { this.db.prepare("UPDATE jobs SET status=CASE WHEN reply IS NULL THEN 'pending' ELSE 'ready' END,available_at=? WHERE id=? AND status<>'cancelled'").run(at, id); }
  failJob(id: string, error: string, blocked: boolean): void {
    this.db.prepare("UPDATE jobs SET status=?,error=? WHERE id=? AND status<>'cancelled'").run(blocked ? "blocked" : "failed", error.slice(0, 1000), id);
  }
  hasBlocked(server: string, channel: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM jobs WHERE server=? AND channel=? AND status='blocked' LIMIT 1").get(server, channel)); }
  hasPendingOther(server: string, channel: string, messageId: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM jobs WHERE server=? AND channel=? AND message_id<>? AND status='pending' LIMIT 1").get(server, channel, messageId)); }
  jobs(server: string, channel: string): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE server=? AND channel=? ORDER BY sequence DESC LIMIT 20").all(server, channel).map(row => this.job(row));
  }
  resumeJob(id: string): boolean {
    return this.db.prepare("UPDATE jobs SET status=CASE WHEN reply IS NULL THEN 'pending' ELSE 'ready' END,error=NULL,available_at=0 WHERE id=? AND status='cancelled'").run(id).changes === 1;
  }
  cancelJob(id: string): boolean {
    return this.db.prepare("UPDATE jobs SET status='cancelled',error='Stopped' WHERE id=? AND status IN ('pending','ready','running','sending')").run(id).changes === 1;
  }
  retryJob(server: string, channel: string, id: string): boolean {
    return this.db.prepare("UPDATE jobs SET status=CASE WHEN reply IS NULL THEN 'pending' ELSE 'ready' END,error=NULL WHERE server=? AND channel=? AND id=? AND status IN ('failed','blocked')").run(server, channel, id).changes === 1;
  }

  operation(id: string): ToolOperation | undefined {
    const row = this.db.prepare("SELECT * FROM tool_operations WHERE id=?").get(id);
    return row ? { id, name: String(row.name), args: JSON.parse(String(row.args)) as ToolArgs, resource: row.resource === null ? null : String(row.resource), status: row.status as ToolOperation["status"], result: row.result === null ? null : String(row.result) } : undefined;
  }
  blockingOperation(resource: string, exceptId: string): BlockingOperation | undefined {
    const row = this.db.prepare("SELECT id,created_at FROM tool_operations WHERE resource=? AND id<>? AND status='started' LIMIT 1").get(resource, exceptId);
    return row ? { id: String(row.id), startedAt: Number(row.created_at) } : undefined;
  }
  expireOperations(resource: string, startedBefore: number, exceptId: string, result: string): void {
    this.db.prepare("UPDATE tool_operations SET status='failed',result=? WHERE resource=? AND id<>? AND status='started' AND created_at<?").run(result, resource, exceptId, startedBefore);
  }
  beginOperation(context: ToolContext, name: string, args: ToolArgs): void {
    const message = context.message;
    this.db.prepare("INSERT INTO tool_operations(id,server,channel,author,message_id,name,args,status,result,created_at,resource) VALUES(?,?,?,?,?,?,?,'started',NULL,?,?)").run(context.operationId, message.server, message.channel, message.author, message.id, name, JSON.stringify(args), Date.now(), context.resource);
  }
  endOperation(id: string, result: string, failed = false): void {
    this.db.prepare("UPDATE tool_operations SET status=?,result=? WHERE id=?").run(failed ? "failed" : "done", result, id);
  }
  delivery(id: string): { message: Message; content: string; createdAt: number; result: Message | null } | undefined {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id);
    return row ? { message: parseMessage(JSON.parse(String(row.message))), content: String(row.content), createdAt: Number(row.created_at), result: row.result ? parseMessage(JSON.parse(String(row.result))) : null } : undefined;
  }
  prepareDelivery(id: string, message: Message, content: string): void {
    this.db.prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?,NULL)").run(id, JSON.stringify(message), content, Date.now());
  }
  finishDelivery(id: string, result: Message): void { this.db.prepare("UPDATE deliveries SET result=? WHERE id=?").run(JSON.stringify(result), id); }
  async countRepliesSince(since: number): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(DISTINCT json_extract(message,'$.server')||':'||json_extract(message,'$.id')) AS n FROM deliveries WHERE result IS NOT NULL AND created_at>=?").get(since);
    return Number(row?.n ?? 0);
  }

  setting(server: string, key: string): unknown {
    const row = this.db.prepare("SELECT value FROM settings WHERE server=? AND key=?").get(server, key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }

  setSetting(server: string, key: string, value: Json): void {
    this.db.prepare("INSERT OR REPLACE INTO settings VALUES(?,?,?)").run(server, key, JSON.stringify(value));
  }

  // Web replies (src/web-replies.ts).
  webWebhook(server: string, channel: string): WebWebhookRow | undefined {
    const row = this.db.prepare("SELECT server,channel,webhook_id,token_encrypted FROM web_webhooks WHERE server=? AND channel=?").get(server, channel);
    return row ? { server: String(row.server), channel: String(row.channel), webhook_id: String(row.webhook_id), token_encrypted: String(row.token_encrypted) } : undefined;
  }
  webWebhookByHook(server: string, webhookId: string): WebWebhookRow | undefined {
    const row = this.db.prepare("SELECT server,channel,webhook_id,token_encrypted FROM web_webhooks WHERE server=? AND webhook_id=?").get(server, webhookId);
    return row ? { server: String(row.server), channel: String(row.channel), webhook_id: String(row.webhook_id), token_encrypted: String(row.token_encrypted) } : undefined;
  }
  saveWebWebhook(row: WebWebhookRow): void {
    this.db.prepare("INSERT INTO web_webhooks VALUES(?,?,?,?) ON CONFLICT(server,channel) DO UPDATE SET webhook_id=excluded.webhook_id,token_encrypted=excluded.token_encrypted").run(row.server, row.channel, row.webhook_id, row.token_encrypted);
  }
  deleteWebWebhook(server: string, channel: string): void {
    this.db.prepare("DELETE FROM web_webhooks WHERE server=? AND channel=?").run(server, channel);
  }
  insertWebReply(row: WebReplyRow): void {
    this.db.prepare("INSERT INTO web_replies (id,server,channel,user_id,status,message_id,created_at,via) VALUES(?,?,?,?,?,?,?,?)").run(row.id, row.server, row.channel, row.user_id, row.status, row.message_id, row.created_at, row.via);
  }
  finishWebReply(id: string, status: "posted" | "failed", messageId?: string, via?: WebVia): boolean {
    return this.db.prepare("UPDATE web_replies SET status=?,message_id=?,via=COALESCE(?,via) WHERE id=? AND status='pending'").run(status, messageId ?? null, via ?? null, id).changes > 0;
  }
  webReplyByMessage(server: string, messageId: string): WebReplyRow | undefined {
    const row = this.db.prepare("SELECT id,server,channel,user_id,status,message_id,created_at,via FROM web_replies WHERE server=? AND message_id=?").get(server, messageId);
    return row ? { id: String(row.id), server: String(row.server), channel: String(row.channel), user_id: String(row.user_id), status: String(row.status) as WebReplyRow["status"], message_id: row.message_id === null ? null : String(row.message_id), created_at: Number(row.created_at), via: String(row.via) as WebReplyRow["via"] } : undefined;
  }

  private userWindows(server: string, user: string): UserLimitWindow[] {
    return this.db.prepare("SELECT kind, window_start, spent FROM user_limit_counters WHERE server=? AND user_id=?").all(server, user)
      .map(row => ({ kind: String(row.kind), windowStart: Number(row.window_start), spent: Number(row.spent) }));
  }
  async userUsage(server: string, user: string): Promise<UserLimitState> {
    const resets = Object.fromEntries(this.db.prepare("SELECT kind, count FROM user_limit_resets WHERE server=? AND user_id=?").all(server, user).map(row => [String(row.kind), Number(row.count)]));
    return { windows: this.userWindows(server, user), resets };
  }
  async updateUserLimits<T>(server: string, user: string, change: (windows: readonly UserLimitWindow[]) => { windows?: readonly UserLimitWindow[]; result: T }): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const next = change(this.userWindows(server, user));
      for (const window of next.windows ?? []) this.db.prepare("INSERT INTO user_limit_counters VALUES(?,?,?,?,?) ON CONFLICT(server,user_id,kind) DO UPDATE SET window_start=excluded.window_start,spent=excluded.spent").run(server, user, window.kind, window.windowStart, window.spent);
      this.db.exec("COMMIT");
      return next.result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async resetUserUsage(server: string, user: string, kind?: string): Promise<void> {
    // No kind, or a week reset (a full reset), clears both windows.
    if (kind === undefined || kind === "week") this.db.prepare("DELETE FROM user_limit_counters WHERE server=? AND user_id=?").run(server, user);
    else this.db.prepare("DELETE FROM user_limit_counters WHERE server=? AND user_id=? AND kind=?").run(server, user, kind);
  }
  async listUserUsage(server: string, limit: number): Promise<UserLimitRow[]> {
    const users = this.db.prepare("SELECT u.user_id AS uid FROM (SELECT user_id FROM user_limit_counters WHERE server=? UNION SELECT user_id FROM user_limit_resets WHERE server=?) u LEFT JOIN user_limit_counters c ON c.server=? AND c.user_id=u.user_id AND c.kind='5h' ORDER BY COALESCE(c.spent,0) DESC, u.user_id LIMIT ?").all(server, server, server, limit);
    const rows: UserLimitRow[] = [];
    for (const row of users) rows.push({ user: String(row.uid), ...await this.userUsage(server, String(row.uid)) });
    return rows;
  }
  async grantResets(server: string, user: string, kind: string, count: number): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Reset count must be a positive integer");
    this.db.prepare("INSERT INTO user_limit_resets VALUES(?,?,?,?) ON CONFLICT(server,user_id,kind) DO UPDATE SET count=user_limit_resets.count+excluded.count").run(server, user, kind, count);
  }
  // Never deleted by chat delete, purge, retention or purgeUnconfigured (see tests/token-totals.test.ts).
  async addTokenTotals(server: string, user: string, model: string, totals: TokenTotals, at: number): Promise<void> {
    this.db.prepare(`INSERT INTO user_token_totals VALUES(?,?,?,1,?,?,?,?,?,?)
      ON CONFLICT(server,user_id,model) DO UPDATE SET requests=user_token_totals.requests+1, input_tokens=user_token_totals.input_tokens+excluded.input_tokens, output_tokens=user_token_totals.output_tokens+excluded.output_tokens, cached_tokens=user_token_totals.cached_tokens+excluded.cached_tokens, cost_micros=user_token_totals.cost_micros+excluded.cost_micros, last_at=CASE WHEN excluded.last_at>user_token_totals.last_at THEN excluded.last_at ELSE user_token_totals.last_at END`)
      .run(server, user, model, totals.input, totals.output, totals.cached, totals.costMicros, at, at);
  }
  async userTokenTotals(server: string, user: string): Promise<UserTokenTotalRow[]> {
    return this.db.prepare("SELECT model,requests,input_tokens,output_tokens,cached_tokens,cost_micros,first_at,last_at FROM user_token_totals WHERE server=? AND user_id=? ORDER BY model").all(server, user)
      .map(row => ({ model: String(row.model), requests: Number(row.requests), input: Number(row.input_tokens), output: Number(row.output_tokens), cached: Number(row.cached_tokens), costMicros: Number(row.cost_micros), firstAt: Number(row.first_at), lastAt: Number(row.last_at) }));
  }
  async listKnownUsers(search: string, limit: number, offset: number): Promise<KnownUserPage> {
    const directory = this.db.prepare("SELECT server,author,names,bot FROM author_directory ORDER BY server,author").all();
    const spent = new Map(this.db.prepare("SELECT user_id,spent FROM user_limit_counters WHERE server='global' AND kind='5h'").all().map(row => [String(row.user_id), Number(row.spent)]));
    const banked = this.db.prepare("SELECT DISTINCT user_id FROM user_limit_resets WHERE server='global'").all().map(row => String(row.user_id));
    const people = new Map<string, { names: string[]; servers: string[] }>();
    // Users are the non-web human authors, plus anyone with global limit rows. Names come from every row.
    const listed = new Set<string>();
    for (const row of directory) {
      const user = String(row.author), entry = people.get(user) ?? { names: [], servers: [] };
      for (const name of JSON.parse(String(row.names)) as string[]) if (!entry.names.includes(name)) entry.names.push(name);
      if (Number(row.bot) === 0 && String(row.server) !== "web") { listed.add(user); entry.servers.push(String(row.server)); }
      people.set(user, entry);
    }
    const all = [...new Set([...listed, ...spent.keys(), ...banked])].map(user => ({ user, names: people.get(user)?.names ?? [], servers: [...(people.get(user)?.servers ?? [])].sort(), spent: spent.get(user) ?? 0 }));
    const term = search.trim(), lower = term.toLowerCase();
    const matches = term === "" ? all
      : /^\d+$/.test(term) && all.some(row => row.user === term) ? all.filter(row => row.user === term)
      : all.filter(row => row.names.some(name => name.toLowerCase().includes(lower)));
    const first = (row: { names: string[] }) => (row.names[0] ?? "").toLowerCase();
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    matches.sort((a, b) => b.spent - a.spent || compare(first(a), first(b)) || compare(a.user, b.user));
    return { total: matches.length, users: matches.slice(offset, offset + limit).map(({ user, names, servers }) => ({ user, names, servers })) };
  }
  async userTokenTotalsByServer(user: string): Promise<(UserTokenTotalRow & { server: string })[]> {
    return this.db.prepare("SELECT server,model,requests,input_tokens,output_tokens,cached_tokens,cost_micros,first_at,last_at FROM user_token_totals WHERE user_id=? ORDER BY server,model").all(user)
      .map(row => ({ server: String(row.server), model: String(row.model), requests: Number(row.requests), input: Number(row.input_tokens), output: Number(row.output_tokens), cached: Number(row.cached_tokens), costMicros: Number(row.cost_micros), firstAt: Number(row.first_at), lastAt: Number(row.last_at) }));
  }
  async tokenTotalsSummary(limit: number): Promise<TokenTotalsSummary> {
    const [total] = this.db.prepare("SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cached_tokens),0) AS cached, COALESCE(SUM(cost_micros),0) AS cost FROM user_token_totals").all();
    const servers = this.db.prepare("SELECT server, SUM(requests) AS requests, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cached_tokens) AS cached, SUM(cost_micros) AS cost FROM user_token_totals GROUP BY server ORDER BY cost DESC, server LIMIT ?").all(limit);
    const models = this.db.prepare("SELECT model, SUM(requests) AS requests, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cached_tokens) AS cached, SUM(cost_micros) AS cost FROM user_token_totals GROUP BY model ORDER BY cost DESC, model LIMIT ?").all(limit);
    return {
      total: { requests: Number(total?.requests ?? 0), input: Number(total?.input ?? 0), output: Number(total?.output ?? 0), cached: Number(total?.cached ?? 0), costMicros: Number(total?.cost ?? 0) },
      servers: servers.map(row => ({ server: String(row.server), requests: Number(row.requests), input: Number(row.input), output: Number(row.output), cached: Number(row.cached), costMicros: Number(row.cost) })),
      models: models.map(row => ({ model: String(row.model), requests: Number(row.requests), input: Number(row.input), output: Number(row.output), cached: Number(row.cached), costMicros: Number(row.cost) })),
    };
  }

  async useReset(server: string, user: string, kind: string): Promise<boolean> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT count FROM user_limit_resets WHERE server=? AND user_id=? AND kind=?").get(server, user, kind);
      if (!row || Number(row.count) < 1) { this.db.exec("COMMIT"); return false; }
      this.db.prepare("UPDATE user_limit_resets SET count=count-1 WHERE server=? AND user_id=? AND kind=?").run(server, user, kind);
      // A week reset is a full reset: it clears the 5-hour window too.
      if (kind === "week") this.db.prepare("DELETE FROM user_limit_counters WHERE server=? AND user_id=?").run(server, user);
      else this.db.prepare("DELETE FROM user_limit_counters WHERE server=? AND user_id=? AND kind=?").run(server, user, kind);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async listProviderKeys(): Promise<ProviderKeyRow[]> {
    return this.db.prepare("SELECT id,provider,owner,label,last4,secret_encrypted,created_at FROM web_provider_keys ORDER BY created_at,id").all().map(providerKeyRow);
  }
  async addProviderKey(row: ProviderKeyRow): Promise<void> {
    this.db.prepare("INSERT INTO web_provider_keys (id,provider,owner,label,last4,secret_encrypted,created_at) VALUES(?,?,?,?,?,?,?)").run(row.id, row.provider, row.owner, row.label, row.last4, row.secretEncrypted, row.createdAt);
  }
  async deleteProviderKey(id: string): Promise<boolean> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM web_provider_usage WHERE key_id=?").run(id);
      const changes = this.db.prepare("DELETE FROM web_provider_keys WHERE id=?").run(id).changes;
      this.db.exec("COMMIT");
      return Number(changes) === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  // Picks the key in one transaction. BEGIN IMMEDIATE takes the write lock, so no other write runs between the read and the upsert.
  async reserveProviderCredits(provider: KeyedProvider, month: string, credits: number, cap: number): Promise<ProviderKeyRow | undefined> {
    if (!Number.isSafeInteger(credits) || credits < 1) throw new Error("Provider credits must be a positive integer");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT k.id,k.provider,k.owner,k.label,k.last4,k.secret_encrypted,k.created_at FROM web_provider_keys k
        LEFT JOIN web_provider_usage u ON u.key_id=k.id AND u.month=?
        WHERE k.provider=? AND COALESCE(u.exhausted,0)=0 AND COALESCE(u.used,0)+?<=?
        ORDER BY COALESCE(u.used,0), k.created_at, k.id LIMIT 1`).get(month, provider, credits, cap);
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      const picked = providerKeyRow(row);
      this.db.prepare("INSERT INTO web_provider_usage (key_id,month,used,exhausted) VALUES(?,?,?,0) ON CONFLICT(key_id,month) DO UPDATE SET used=web_provider_usage.used+excluded.used").run(picked.id, month, credits);
      this.db.exec("COMMIT");
      return picked;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async exhaustProviderKey(id: string, month: string): Promise<void> {
    this.db.prepare("INSERT INTO web_provider_usage (key_id,month,used,exhausted) VALUES(?,?,0,1) ON CONFLICT(key_id,month) DO UPDATE SET exhausted=1").run(id, month);
  }
  async resetProviderKey(id: string, month: string): Promise<void> {
    this.db.prepare("UPDATE web_provider_usage SET exhausted=0 WHERE key_id=? AND month=?").run(id, month);
  }
  async providerKeyUsage(month: string): Promise<ProviderKeyUsage[]> {
    return this.db.prepare("SELECT key_id,month,used,exhausted FROM web_provider_usage WHERE month=? ORDER BY key_id").all(month)
      .map(row => ({ keyId: String(row.key_id), month: String(row.month), used: Number(row.used), exhausted: Number(row.exhausted) !== 0 }));
  }

  reindex(server: string, channels: readonly string[]): number {
    if (!this.embeddings || !channels.length) return 0;
    // Private chats are never indexed for search, even when a caller passes their channel.
    const rows = this.db.prepare(`SELECT m.* FROM memories m WHERE m.server=?
      AND m.status='active' AND m.channel NOT LIKE 'web:%' AND m.channel IN (${channels.map(() => "?").join(",")}) AND NOT EXISTS
      (SELECT 1 FROM memory_embeddings e WHERE e.server=m.server AND e.memory_id=m.id AND e.model=?)`)
      .all(server, ...channels, this.embeddings.model);
    for (const row of rows) this.queueIndex({ server, channel: String(row.channel), author: String(row.author), id: String(row.id), text: String(row.content) }, false);
    return rows.length;
  }

  // Deletes only saved messages. Memories and embeddings made from them are not changed.
  async purgeChannelBefore(server: string, channel: string, cutoff: number): Promise<{ id: string; timestamp: number } | null> {
    const time = "json_extract(body,'$.timestamp')";
    this.db.prepare(`DELETE FROM messages WHERE server=? AND channel=? AND ${time}<?`).run(server, channel, cutoff);
    const row = this.db.prepare(`SELECT id,${time} AS timestamp FROM messages WHERE server=? AND channel=? AND ${time} IS NOT NULL ORDER BY ${time} ASC,length(id) ASC,id ASC LIMIT 1`).get(server, channel);
    return row ? { id: String(row.id), timestamp: Number(row.timestamp) } : null;
  }

  purgeUnconfigured(server: string, allowed: readonly string[]): void {
    const rows = this.db.prepare("SELECT id,channel FROM messages WHERE server=?").all(server);
    for (const row of rows) {
      // Private chats are removed only by their owner, never by this cleanup.
      if (allowed.includes(String(row.channel)) || isPrivateChannel(String(row.channel))) continue;
      this.invalidateSource(server, String(row.id));
      this.db.prepare("DELETE FROM messages WHERE server=? AND id=?").run(server, String(row.id));
      this.invalidate(server, String(row.channel), { reason: "channel_disabled", sourceId: String(row.id) });
    }
    const histories = this.db.prepare("SELECT key FROM settings WHERE server=? AND key LIKE 'history:%'").all(server);
    for (const row of histories) if (!allowed.includes(String(row.key).slice(8))) this.db.prepare("DELETE FROM settings WHERE server=? AND key=?").run(server, String(row.key));
    const jobs = this.db.prepare("SELECT id,channel FROM jobs WHERE server=? AND status NOT IN ('done','cancelled')").all(server);
    for (const row of jobs) if (!allowed.includes(String(row.channel)) && !isPrivateChannel(String(row.channel))) this.db.prepare("UPDATE jobs SET status='cancelled',error='Channel disabled' WHERE id=?").run(String(row.id));
  }

  // charge is false for an admin reindex: old messages are not charged to their authors again.
  private queueIndex(message: Message, charge = true): void {
    if (!this.embeddings || !message.text.trim()) return;
    this.indexTail = this.indexTail.then(async () => {
      const existing = this.db.prepare("SELECT 1 FROM memory_embeddings WHERE server=? AND memory_id=? AND model=?").get(message.server, message.id, this.embeddings!.model);
      if (existing) return;
      const vector = await this.embed(message, "memory_index", charge ? attribution(message) : undefined);
      const current = this.db.prepare("SELECT content FROM memories WHERE server=? AND id=? AND status='active'").get(message.server, message.id);
      if (!current || String(current.content) !== message.text) return;
      this.db.prepare("INSERT OR REPLACE INTO memory_embeddings VALUES(?,?,?,?)")
        .run(message.server, message.id, this.embeddings!.model, JSON.stringify(vector));
    }).catch(error => logError("memory_embedding_index_failed", error, { stage: "memory embedding indexing", server: message.server, channel: message.channel, messageId: message.id }));
  }

  indexStats(server: string, channel: string): { messages: number; vectors: number; oldest: number | null; newest: number | null; usage: { model: string; purpose: string; requests: number; tokens: number; unknown: number }[] } {
    const row = this.db.prepare("SELECT count(*) AS count,min(json_extract(body,'$.timestamp')) AS oldest,max(json_extract(body,'$.timestamp')) AS newest FROM messages WHERE server=? AND channel=?").get(server, channel)!;
    const vectors = this.db.prepare("SELECT count(*) AS count FROM memory_embeddings e JOIN memories m ON m.server=e.server AND m.id=e.memory_id WHERE m.server=? AND m.channel=? AND m.status='active' AND e.model=?").get(server, channel, this.embeddings?.model ?? "")!;
    const usage = this.db.prepare("SELECT * FROM embedding_usage WHERE server=? AND channel=?").all(server, channel).map(value => ({ model: String(value.model), purpose: String(value.purpose), requests: Number(value.requests), tokens: Number(value.tokens), unknown: Number(value.unknown_tokens) }));
    return { messages: Number(row.count), vectors: Number(vectors.count), oldest: row.oldest === null ? null : Number(row.oldest), newest: row.newest === null ? null : Number(row.newest), usage };
  }

  private async embed(message: Message, purpose: "memory_index" | "memory_query", who?: Attribution): Promise<readonly number[]> {
    const result = this.embeddings!.embedWithUsage
      ? await this.embeddings!.embedWithUsage(message.text, who)
      : { vector: await this.embeddings!.embed(message.text), tokens: null };
    this.db.prepare(`INSERT INTO embedding_usage VALUES(?,?,?,?,1,?,?)
      ON CONFLICT(server,channel,model,purpose) DO UPDATE SET requests=requests+1,tokens=tokens+excluded.tokens,unknown_tokens=unknown_tokens+excluded.unknown_tokens`)
      .run(message.server, message.channel, this.embeddings!.model, purpose, result.tokens ?? 0, result.tokens === null ? 1 : 0);
    return result.vector;
  }

  async remember(message: Message, content: string): Promise<MemoryRecord> {
    if (!content.trim() || content.length > 2000) throw new Error("Memory must contain 1–2000 characters");
    if (!this.db.prepare("SELECT 1 FROM messages WHERE server=? AND channel=? AND id=?")
      .get(message.server, message.channel, message.id)) throw new Error("Memory source is unavailable");
    const memory: MemoryRecord = {
      id: randomUUID(), server: message.server, channel: message.channel, author: message.author,
      content: content.trim(), sourceIds: [message.id], status: "active",
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO memories VALUES(?,?,?,?,?,?,?)")
        .run(memory.id, memory.server, memory.channel, memory.author, memory.content, memory.status, Date.now());
      this.db.prepare("INSERT INTO memory_sources VALUES(?,?,?)").run(memory.id, memory.server, message.id);
      this.bumpVersion(message.server, message.channel);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.queueIndex({ ...message, id: memory.id, text: memory.content });
    return memory;
  }

  async memories(server: string, channel: string): Promise<readonly MemoryRecord[]> {
    return this.db.prepare(`SELECT * FROM memories m WHERE server=? AND channel=? AND status='active'
      AND NOT EXISTS(SELECT 1 FROM memory_sources s WHERE s.memory_id=m.id AND NOT EXISTS
        (SELECT 1 FROM messages x WHERE x.server=s.server AND x.id=s.message_id))
      ORDER BY created_at DESC, rowid DESC`).all(server, channel).map(row => ({
      id: String(row.id), server, channel, author: String(row.author), content: String(row.content), status: "active",
      sourceIds: this.db.prepare("SELECT message_id FROM memory_sources WHERE memory_id=?")
        .all(String(row.id)).map(source => String(source.message_id)),
    }));
  }

  async forget(server: string, channel: string, id: string, actor: string): Promise<boolean> {
    const result = this.db.prepare("UPDATE memories SET status='forgotten' WHERE id=? AND server=? AND channel=? AND author=? AND status='active'")
      .run(id, server, channel, actor);
    if (result.changes) {
      const sources = this.db.prepare("SELECT message_id FROM memory_sources WHERE memory_id=?").all(id);
      for (const row of sources) {
        const source = String(row.message_id);
        this.invalidateSource(server, source);
        this.db.prepare("DELETE FROM messages WHERE server=? AND id=?").run(server, source);
        this.db.prepare("INSERT OR IGNORE INTO message_tombstones VALUES(?,?)").run(server, source);
      }
      this.invalidate(server, channel, { reason: "memory_forgotten", ...(sources[0] ? { sourceId: String(sources[0].message_id) } : {}) });
    }
    return Boolean(result.changes);
  }

  async retrieve(message: Message, limit: number): Promise<readonly Evidence[]> {
    const evidence: Evidence[] = [];
    // Resolve people from scoped canonical authors, never from generated descriptions.
    const directory = this.db.prepare(`SELECT DISTINCT d.author,d.names,d.bot FROM author_directory d JOIN messages m
      ON m.server=d.server AND json_extract(m.body,'$.author')=d.author WHERE m.server=? AND m.channel=?`).all(message.server,message.channel);
    for (const row of directory) {
      const aliases = this.profile(message.server, String(row.author)).fields.filter(item => ["real_name", "nickname", "nicknames", "aliases"].includes(item.field)).flatMap(item => typeof item.value === "string" ? [item.value] : Array.isArray(item.value) ? item.value.filter((value): value is string => typeof value === "string") : []);
      row.names = JSON.stringify([...JSON.parse(String(row.names)), ...aliases]);
    }
    const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const match = (text: string) => directory.filter(row => !row.bot && (text.includes(`<@${row.author}>`) || text.includes(`<@!${row.author}>`) ||
      (JSON.parse(String(row.names)) as string[]).some(name => normalized(name).length > 2 && (` ${normalized(text)} `).includes(` ${normalized(name)} `))));
    let targets = match(message.text);
    const recent = this.canonicalMessage(message.server, message.id) ? await this.context(message, 12) : [];
    if (!targets.length && /\b(he|him|his|they|them|their|other|more|quotes?)\b/i.test(message.text)) {
      for (const prior of [...recent].reverse()) {
        if (prior.author !== message.author || prior.isBot) continue;
        targets = match(prior.text);
        if (targets.length) break;
      }
    }
    const personQuery = /\b(said|say|quotes?)\b/i.test(message.text) || /^I meant\b/i.test(message.text);
    if (targets.length === 1 && personQuery) {
      const target = targets[0]!, count = Math.min(20, Math.max(limit, Number(message.text.match(/\b(\d{1,2})\b/)?.[1] ?? (/\bten\b/i.test(message.text) ? 10 : limit))));
      const rows = this.db.prepare(`SELECT body FROM messages WHERE server=? AND channel=? AND json_extract(body,'$.author')=? AND id<>?
        ORDER BY coalesce(json_extract(body,'$.timestamp'),sequence) DESC LIMIT ?`).all(message.server,message.channel,String(target.author),message.id,count);
      evidence.push({ kind: "retrieval", targetAuthor: String(target.author), author: String(target.author), sourceIds: [], content: `Resolved person: ${String(target.names)}; exact author ID ${target.author}. These are stored messages by this person, not a claim about the whole channel's history.` });
      for (const row of rows) {
        const item = parseMessage(JSON.parse(String(row.body)));
        evidence.push({ kind: "message", content: item.text, author: item.author, authorName: (JSON.parse(String(target.names)) as string[])[0] ?? String(target.author), sourceIds: [item.id], sourceUrl: `https://discord.com/channels/${message.server}/${message.channel}/${item.id}` });
      }
      return evidence;
    }
    if (personQuery) return [{ kind: "retrieval", author: "system", sourceIds: [], content: targets.length > 1 ? "Person name is ambiguous. Ask which member the requester means before attributing messages." : "Could not resolve the requested person from known channel author names. Ask for their Discord mention. Do not attribute unrelated recent chat to them." }];
    const terms = searchTerms(message.text);
    const notes = await this.memories(message.server, message.channel);
    const semanticScores = new Map<string, number>();
    if (this.embeddings && notes.length && message.text.trim()) {
      try {
        const rows = this.db.prepare(`SELECT e.memory_id,e.vector FROM memory_embeddings e JOIN memories m ON m.server=e.server AND m.id=e.memory_id WHERE m.server=? AND m.channel=? AND m.status='active' AND e.model=?`)
          .all(message.server, message.channel, this.embeddings.model);
        if (rows.length) {
          const query = await this.embed(message, "memory_query", attribution(message));
          for (const row of rows) semanticScores.set(String(row.memory_id), cosine(query, JSON.parse(String(row.vector))));
        }
      } catch (error) { logError("memory_embedding_query_failed", error, { server: message.server, channel: message.channel }); }
    }
    const score = (memory: MemoryRecord) => terms.filter(term => memory.content.toLowerCase().includes(term)).length + Math.max(0, semanticScores.get(memory.id) ?? 0);
    const relevant = [...notes].sort((a, b) => score(b) - score(a)).slice(0, Math.min(limit, 4));
    for (const memory of relevant) evidence.push({ kind: "memory", content: memory.content, author: memory.author, sourceIds: memory.sourceIds });
    const recalled=await this.searchHistory({server:message.server,channel:message.channel,query:message.text,mode:'keyword',limit,excludeId:message.id,requester:message.isBot?undefined:message.author});
    const selected=new Map(recalled.messages.map(item=>[item.id,item]));
    for (const item of selected.values()) {
      if (evidence.length >= limit) break;
      evidence.push({ kind: "message", content: item.text, author: item.author, sourceIds: [item.id] });
    }
    return evidence;
  }

  async recordSources(runId: string, server: string, sourceIds: readonly string[]): Promise<void> {
    const insert = this.db.prepare("INSERT OR IGNORE INTO run_sources VALUES(?,?,?)");
    for (const id of sourceIds) insert.run(runId, server, id);
    const run = this.db.prepare("SELECT message FROM runs WHERE id=?").get(runId);
    if (!run) return;
    const message = parseMessage(JSON.parse(String(run.message)));
    if (message.taskId) {
      const previous = this.db.prepare(`SELECT DISTINCT s.message_id FROM run_sources s JOIN runs r ON r.id=s.run_id
        JOIN messages m ON m.server=s.server AND m.id=s.message_id
        WHERE r.status='completed' AND s.server=? AND json_extract(r.message,'$.channel')=? AND json_extract(r.message,'$.taskId')=?`)
        .all(server, message.channel, message.taskId);
      for (const row of previous) insert.run(runId, server, String(row.message_id));
    }
  }

  async linkOutput(message: Message, runId: string | undefined, sourceId: string): Promise<void> {
    const sources = runId ? this.db.prepare("SELECT message_id FROM run_sources WHERE run_id=? AND server=?")
      .all(runId, message.server).map(row => String(row.message_id)) : [sourceId];
    const insert = this.db.prepare("INSERT OR IGNORE INTO source_dependents VALUES(?,?,?)");
    for (const source of sources.length ? sources : [sourceId]) insert.run(message.server, source, message.id);
    // Web transcripts: a Slopbot reply links to every reply run of its request.
    const runs = new Set([...(runId ? [runId] : []), ...await this.requestRunIds(message.server, sourceId)]);
    const link = this.db.prepare("INSERT OR IGNORE INTO reply_runs VALUES(?,?,?)");
    for (const run of runs) link.run(message.server, message.id, run);
  }

  private bumpVersion(server: string, channel: string): void {
    this.db.prepare("INSERT INTO context_versions VALUES(?,?,1) ON CONFLICT(server,channel) DO UPDATE SET version=version+1")
      .run(server, channel);
  }

  private invalidateSource(server: string, id: string, seen = new Set<string>()): void {
    if (seen.has(id)) return;
    seen.add(id);
    this.db.prepare("UPDATE memories SET status='invalidated' WHERE status='active' AND id IN (SELECT memory_id FROM memory_sources WHERE server=? AND message_id=?)")
      .run(server, id);
    this.db.prepare("UPDATE profile_events SET valid=0 WHERE server=? AND id IN (SELECT e.id FROM profile_events e,json_each(e.sources) s WHERE e.server=? AND s.value=?)").run(server, server, id);
    this.db.prepare("DELETE FROM memory_embeddings WHERE server=? AND memory_id IN (SELECT memory_id FROM memory_sources WHERE server=? AND message_id=?)").run(server, server, id);
    const dependents = this.db.prepare("SELECT output_id FROM source_dependents WHERE server=? AND source_id=?").all(server, id);
    for (const dependent of dependents) {
      const output = String(dependent.output_id);
      this.invalidateSource(server, output, seen);
      this.db.prepare("DELETE FROM messages WHERE server=? AND id=?").run(server, output);
      this.db.prepare("INSERT OR IGNORE INTO message_tombstones VALUES(?,?)").run(server, output);
    }
  }

  async contextVersion(server: string, channel: string): Promise<number> {
    const row = this.db.prepare("SELECT version FROM context_versions WHERE server=? AND channel=?").get(server, channel);
    return Number(row?.version ?? 0);
  }

  taskThreads(server: string): { thread: string; parent: string }[] {
    return this.db.prepare("SELECT thread,parent FROM task_threads WHERE server=?").all(server)
      .map(row => ({ thread: String(row.thread), parent: String(row.parent) }));
  }

  registerTask(server: string, thread: string, parent: string, sourceId?: string): void {
    this.db.prepare("INSERT OR IGNORE INTO task_threads(server,thread,parent,source_id) VALUES(?,?,?,?)").run(server, thread, parent, sourceId ?? null);
  }
  taskForSource(server: string, sourceId: string): string | undefined {
    const row = this.db.prepare("SELECT thread FROM task_threads WHERE server=? AND source_id=?").get(server, sourceId);
    return row ? String(row.thread) : undefined;
  }

  async revise(message: Message): Promise<void> {
    const row = this.db.prepare("SELECT body FROM messages WHERE server=? AND id=? AND channel=?")
      .get(message.server, message.id, message.channel);
    if (!row) return;
    const previous = parseMessage(JSON.parse(String(row.body)));
    if (message.transient || previous.transient || legacyToolProgress(previous) && previous.author === this.setting(message.server, "context_bot_author")) { await this.removeTransient(message.server, message.channel, message.id); return; }
    if (message.revisionTimestamp !== undefined && previous.revisionTimestamp !== undefined && message.revisionTimestamp < previous.revisionTimestamp) return;
    if (sourceFingerprint(previous) === sourceFingerprint(message)) {
      this.db.prepare("UPDATE messages SET body=? WHERE server=? AND id=? AND channel=?").run(JSON.stringify(message), message.server, message.id, message.channel);
      return;
    }
    this.invalidateSource(message.server, message.id);
    this.db.prepare("UPDATE messages SET body=? WHERE server=? AND id=? AND channel=?")
      .run(JSON.stringify(message), message.server, message.id, message.channel);
    this.invalidate(message.server, message.channel, { reason: "message_edited", sourceId: message.id });

  }

  private async removeTransient(server: string, channel: string, id: string): Promise<void> {
    this.db.prepare("DELETE FROM memory_embeddings WHERE server=? AND memory_id IN (SELECT memory_id FROM memory_sources WHERE server=? AND message_id=?)").run(server, server, id);
    this.db.prepare("DELETE FROM messages WHERE server=? AND channel=? AND id=?").run(server, channel, id);
  }

  async remove(server: string, channel: string, id: string): Promise<void> {
    const existing = await this.canonicalMessage(server, id);
    if (existing && (existing.transient || legacyToolProgress(existing) && existing.author === this.setting(server, "context_bot_author"))) { await this.removeTransient(server, channel, id); return; }
    this.invalidateSource(server, id);
    this.db.prepare("INSERT OR IGNORE INTO message_tombstones VALUES(?,?)").run(server, id);
    const result = this.db.prepare("DELETE FROM messages WHERE server=? AND channel=? AND id=?").run(server, channel, id);
    if (result.changes) this.invalidate(server, channel, { reason: "message_deleted", sourceId: id });
  }

  private invalidate(server: string, channel: string, change: ContextChange = { reason: "scope_changed" }): void {
    // Keep original history and reasoning logs. Only remove them from future prompt assembly.
    this.db.prepare("UPDATE task_history SET valid=0 WHERE json_extract(task_key,'$[0]')=? AND json_extract(task_key,'$[1]')=?")
      .run(server, channel);
    this.db.prepare("UPDATE task_checkpoints SET valid=0 WHERE json_extract(task_key,'$[0]')=? AND json_extract(task_key,'$[1]')=?").run(server, channel);
    this.db.prepare("UPDATE agent_turns SET valid=0 WHERE server=? AND (message_id IN (SELECT id FROM messages WHERE server=? AND channel=?) OR message_id IN (SELECT json_extract(message,'$.id') FROM runs WHERE json_extract(message,'$.server')=? AND json_extract(message,'$.channel')=?) OR message_id=?)").run(server, server, channel, server, channel, change.sourceId ?? "");
    this.bumpVersion(server, channel);
    const record = { reason: change.reason, ...(change.sourceId ? { sourceId: change.sourceId } : {}), originChannel: change.originChannel ?? channel };
    this.setSetting(server, `context_change:${channel}`, record);
    console.log(JSON.stringify({ type: "context_invalidated", server, channel, ...record }));
    for (const task of this.taskThreads(server)) {
      if (task.parent === channel) this.invalidate(server, task.thread, { ...change, originChannel: change.originChannel ?? channel });
    }
  }
}
