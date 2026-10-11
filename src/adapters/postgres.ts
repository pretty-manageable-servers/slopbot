// PostgreSQL implementation of the existing persistence contract.
import type { HarnessState, HarnessEvent } from "../harness-state.js";
import type { ToolOutput } from "../tools.js";
import { PostgresDatabase, serializeStore } from "./postgres-database.js";
import { randomUUID } from "node:crypto";
import { parseMessage, type Json, type Message, type ModelEvent, type Prompt, type PromptItem } from "../domain.js";
import type { AgentTurn } from "../ports.js";
import { searchTerms, type Embeddings, type Evidence, type MemoryRecord } from "../memory.js";
import { ToolError } from "../tools.js";
import type { ProfileField, UserProfile } from "../profiles.js";
import type { TaskContext } from "../context.js";
import type { Job } from "../queue.js";
import type { ToolArgs, ToolCall, ToolContext, ToolOperation } from "../tools.js";
import type { HistoryQuery, HistoryPage } from '../search/history-search.js';
import type { AppRecord } from '../records.js';
export class PostgresStore {
  async record(
    server: string,
    kind: string,
    id: string,
  ): Promise<AppRecord | undefined> {
    const row = await this.db
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
    return (
      await this.db
        .prepare(
          "SELECT * FROM app_records WHERE server=? AND kind=? ORDER BY id",
        )
        .all(server, kind)
    ).map((row) => ({
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
        (
          await this.db
            .prepare(
              "INSERT OR IGNORE INTO app_records(server,kind,id,revision,value) VALUES(?,?,?,1,?)",
            )
            .run(server, kind, id, JSON.stringify(value))
        ).changes === 1
      );
    return (
      (
        await this.db
          .prepare(
            "UPDATE app_records SET value=?,revision=revision+1 WHERE server=? AND kind=? AND id=? AND revision=?",
          )
          .run(JSON.stringify(value), server, kind, id, expectedRevision)
      ).changes === 1
    );
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
    let keywords = (
      await this.db
        .prepare(
          `SELECT m.body FROM messages m WHERE ${where}${matches} ORDER BY json_extract(m.body,'$.timestamp') DESC,m.id DESC LIMIT 200`,
        )
        .all(
          ...values,
          ...pattern.map(
            (term) => "%" + term.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%",
          ),
        )
    ).map((row) => parseMessage(JSON.parse(String(row.body))));
    if (request.mode !== "exact" && terms.length) {
      const query = terms.join(" | ");
      keywords = (
        await this.db
          .prepare(
            `SELECT m.body FROM messages m WHERE ${where} AND to_tsvector('simple',json_extract(m.body,'$.text')) @@ to_tsquery('simple',?) ORDER BY ts_rank(to_tsvector('simple',json_extract(m.body,'$.text')),to_tsquery('simple',?)) DESC,json_extract(m.body,'$.timestamp') DESC,m.id DESC LIMIT 200`,
          )
          .all(...values, query, query)
      ).map((row) => parseMessage(JSON.parse(String(row.body))));
    }
    let semantic: Message[] = [];
    let degraded = false;
    if (request.mode === "semantic" || request.mode === "hybrid") {
      if (this.embeddings && request.query.trim()) {
        try {
          const query = await this.embed(
            {
              server: request.server,
              channel: request.channel,
              author: "search",
              id: "search",
              text: request.query,
            },
            "query",
          );
          const ranked = await this.db
            .prepare(
              `SELECT m.body, e.vector AS vector FROM messages m JOIN embeddings e ON e.server=m.server AND e.message_id=m.id WHERE ${where} AND e.model=? AND vector_dims(e.vector)=? ORDER BY e.vector <=> ?::vector LIMIT 200`,
            )
            .all(
              ...values,
              this.embeddings.model,
              query.length,
              JSON.stringify(query),
            );
          semantic = ranked.map((row) =>
            parseMessage(JSON.parse(String(row.body))),
          );
        } catch {
          degraded = true;
        }
      } else degraded = true;
    }
    const lists =
      request.mode === "semantic" && !degraded
        ? [semantic]
        : request.mode === "hybrid"
          ? [keywords, semantic]
          : [keywords];
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
    const target = await this.db
      .prepare(
        "SELECT body FROM messages WHERE server=? AND channel=? AND id=?",
      )
      .get(server, channel, id);
    if (!target) return [];
    const time = parseMessage(JSON.parse(String(target.body))).timestamp ?? 0;
    const before = await this.db
      .prepare(
        "SELECT body FROM messages WHERE server=? AND channel=? AND (COALESCE(json_extract(body,'$.timestamp'),0)<? OR (COALESCE(json_extract(body,'$.timestamp'),0)=? AND id<?)) ORDER BY COALESCE(json_extract(body,'$.timestamp'),0) DESC,id DESC LIMIT ?",
      )
      .all(server, channel, time, time, id, radius);
    const after = await this.db
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

    private readonly settingsCache = new Map<string, unknown>();
    private readonly threadsCache: { server: string; thread: string; parent: string }[] = [];
    private indexTail: Promise<void> = Promise.resolve();
    private indexingStopped = false;
    private constructor(private readonly db: PostgresDatabase, private readonly embeddings?: Embeddings) { }
    static async connect(url: string, embeddings?: Embeddings, schema?: string): Promise<PostgresStore> {
        const db = await PostgresDatabase.connect(url, schema);
        const store = new PostgresStore(db, embeddings);
        for (const row of await db.prepare("SELECT * FROM settings").all()) store.settingsCache.set(JSON.stringify([row.server,row.key]), JSON.parse(String(row.value)));
        for (const row of await db.prepare("SELECT server,thread,parent FROM task_threads").all()) store.threadsCache.push({ server:String(row.server),thread:String(row.thread),parent:String(row.parent) });
        return serializeStore(store);
    }
    private async namedMessage(message: Message): Promise<Message> {
        const row = (await this.db.prepare("SELECT names,bot FROM author_directory WHERE server=? AND author=?").get(message.server, message.author));
        return row ? { ...message, authorName: (JSON.parse(String(row.names)) as string[])[0] ?? message.author, isBot: Boolean(row.bot) } : message;
    }
    async profile(server: string, user: string): Promise<UserProfile> {
        const identity = (await this.db.prepare("SELECT names,identity FROM author_directory WHERE server=? AND author=?").get(server, user));
        const lock = (await this.db.prepare("SELECT allow_edits FROM profile_locks WHERE server=? AND user_id=?").get(server, user));
        const rows = (await this.db.prepare(`SELECT e.* FROM profile_current c JOIN profile_events e ON e.id=c.event_id WHERE c.server=? AND c.user_id=? AND e.valid=1 AND e.value<>'null' ORDER BY c.field`).all(server, user));
        return { userId: user, name: identity ? JSON.parse(String(identity.names))[0] : user, identity: identity ? JSON.parse(String(identity.identity)) : {}, allowEdits: lock ? Boolean(lock.allow_edits) : true, fields: rows.map(row => this.profileField(row)) };
    }
    private profileField(row: Record<string, unknown>): ProfileField {
        return { field: String(row.field), value: JSON.parse(String(row.value)) as Json, editor: String(row.editor), sourceIds: JSON.parse(String(row.sources)) as string[], revision: String(row.id) };
    }
    async findPeople(server: string, query: string): Promise<{
        id: string;
        name: string;
    }[]> {
        const id = query.match(/^<@!?(\d+)>$/)?.[1] ?? (/^\d+$/.test(query) ? query : undefined);
        return (await Promise.all((await this.knownAuthors(server)).map(async ({ author }) => {
            const profile = (await this.profile(server, author)), row = (await this.db.prepare("SELECT names FROM author_directory WHERE server=? AND author=?").get(server, author));
            const names = [...(row ? JSON.parse(String(row.names)) as string[] : []), ...profile.fields.filter(item => ["real_name", "nickname", "nicknames", "aliases"].includes(item.field)).flatMap(item => typeof item.value === "string" ? [item.value] : Array.isArray(item.value) ? item.value.filter((value): value is string => typeof value === "string") : [])];
            return (id ? id === author : names.some(name => name.toLowerCase() === query.trim().toLowerCase())) ? [{ id: author, name: profile.name }] : [];
        }))).flat();
    }
    async editProfile(message: Message, user: string, field: string, value: Json, operation: string, sources = [message.id]): Promise<string> {
        if ((await this.db.prepare("SELECT 1 FROM profile_events WHERE id=?").get(operation)))
            return "Profile change already recorded.";
        if (!/^[a-z][a-z0-9_]{0,47}$/.test(field) || field.startsWith("discord_") || ["server_name", "server_nickname", "display_name"].includes(field))
            throw new ToolError("Use a custom field name; automatic Discord identity is read-only.");
        if (user !== message.author && !(await this.profile(message.server, user)).allowEdits)
            throw new ToolError("The profile owner has disabled edits by other members.");
        if (!(await this.canonicalMessage(message.server, message.id)))
            throw new ToolError("Profile changes require a stored source message.");
        (await this.db.exec("BEGIN IMMEDIATE"));
        try {
            (await this.db.prepare("INSERT INTO profile_events(id,server,user_id,field,value,editor,sources) VALUES(?,?,?,?,?,?,?)").run(operation, message.server, user, field, JSON.stringify(value), message.author, JSON.stringify(sources)));
            (await this.db.prepare("INSERT INTO profile_current VALUES(?,?,?,?) ON CONFLICT(server,user_id,field) DO UPDATE SET event_id=excluded.event_id").run(message.server, user, field, operation));
            (await this.db.prepare("UPDATE context_versions SET version=version+1 WHERE server=?").run(message.server));
            (await this.db.exec("COMMIT"));
        }
        catch (error) {
            (await this.db.exec("ROLLBACK"));
            throw error;
        }
        return `Profile ${field} ${value === null ? "removed" : "updated"}; revision ${operation}.`;
    }
    async lockProfile(server: string, user: string, actor: string, allow: boolean): Promise<void> {
        if (user !== actor)
            throw new ToolError("Only the profile owner may change edit permissions.");
        (await this.db.prepare("INSERT INTO profile_locks VALUES(?,?,?) ON CONFLICT(server,user_id) DO UPDATE SET allow_edits=excluded.allow_edits").run(server, user, allow ? 1 : 0));
    }
    async profileHistory(server: string, user: string, actor: string): Promise<ProfileField[]> {
        if (user !== actor)
            throw new ToolError("Only the profile owner may inspect edit history.");
        return (await this.db.prepare("SELECT * FROM profile_events WHERE server=? AND user_id=? AND valid=1 ORDER BY sequence DESC LIMIT 50").all(server, user)).map(row => this.profileField(row));
    }
    async undoProfile(message: Message, user: string, revision: string, operation: string): Promise<string> {
        if (user !== message.author)
            throw new ToolError("Only the profile owner may undo changes.");
        if ((await this.db.prepare("SELECT 1 FROM profile_events WHERE id=?").get(operation)))
            return "Profile undo already recorded.";
        const event = (await this.db.prepare("SELECT * FROM profile_events WHERE id=? AND server=? AND user_id=? AND valid=1").get(revision, message.server, user));
        if (!event)
            throw new ToolError("Unknown or invalidated revision.");
        const current = (await this.db.prepare("SELECT event_id FROM profile_current WHERE server=? AND user_id=? AND field=?").get(message.server, user, String(event.field)));
        if (current?.event_id !== revision)
            throw new ToolError("A newer edit exists. Undo the current revision first.");
        const previous = (await this.db.prepare("SELECT * FROM profile_events WHERE server=? AND user_id=? AND field=? AND sequence<? AND valid=1 ORDER BY sequence DESC LIMIT 1").get(message.server, user, String(event.field), Number(event.sequence)));
        return (await this.editProfile(message, user, String(event.field), previous ? JSON.parse(String(previous.value)) as Json : null, operation, [message.id, ...(previous ? JSON.parse(String(previous.sources)) as string[] : [])]));
    }
    async knownAuthors(server: string): Promise<{
        author: string;
        named: boolean;
    }[]> {
        return (await this.db.prepare(`SELECT DISTINCT json_extract(m.body,'$.author') AS author, d.author AS named FROM messages m
      LEFT JOIN author_directory d ON d.server=m.server AND d.author=json_extract(m.body,'$.author') WHERE m.server=?`).all(server)).map(row => ({ author: String(row.author), named: row.named !== null }));
    }
    async identifyAuthor(server: string, author: string, names: readonly string[], bot = false, identity: Record<string, string> = {}): Promise<void> {
        const previous = (await this.db.prepare("SELECT names,identity FROM author_directory WHERE server=? AND author=?").get(server, author));
        const aliases = [...new Set([...names, ...(previous ? JSON.parse(String(previous.names)) as string[] : [])])].filter(Boolean).slice(0, 20);
        (await this.db.prepare("INSERT INTO author_directory(server,author,names,bot,identity) VALUES(?,?,?,?,?) ON CONFLICT(server,author) DO UPDATE SET names=excluded.names,bot=excluded.bot,identity=excluded.identity")
            .run(server, author, JSON.stringify(aliases), bot ? 1 : 0, JSON.stringify({ ...(previous ? JSON.parse(String(previous.identity)) : {}), ...identity })));
    }
    async ingest(message: Message): Promise<boolean> {
        if ((await this.db.prepare("SELECT 1 FROM message_tombstones WHERE server=? AND id=?").get(message.server, message.id)))
            return false;
        if (message.authorName)
            (await this.identifyAuthor(message.server, message.author, [message.authorName, ...(message.authorAliases ?? [])], message.isBot, message.authorIdentity));
        const result = (await this.db.prepare("INSERT OR IGNORE INTO messages(server,id,channel,body) VALUES(?,?,?,?)").run(message.server, message.id, message.channel, JSON.stringify(message)));
        if (result.changes === 1)
            this.queueIndex(message);
        return result.changes === 1;
    }
    async context(message: Message, limit: number): Promise<readonly Message[]> {
        const current = (await this.db.prepare("SELECT coalesce(json_extract(body,'$.timestamp'),sequence) AS moment FROM messages WHERE server=? AND id=?")
            .get(message.server, message.id));
        if (!current)
            throw new Error("Message was not ingested");
        const rows = (await this.db.prepare("SELECT body FROM messages WHERE server=? AND channel=? AND coalesce(json_extract(body,'$.timestamp'),sequence)<? ORDER BY coalesce(json_extract(body,'$.timestamp'),sequence) DESC LIMIT ?").all(message.server, message.channel, current.moment!, limit));
        const selected = (await Promise.all(rows.reverse().map(async (row) => (await this.namedMessage(parseMessage(JSON.parse(String(row.body))))))));
        const seen = new Set(selected.map(item => item.id));
        let reference = message.replyTo;
        const visited = new Set<string>();
        for (let count = 0; reference && count < 4; count++) {
            if (visited.has(reference))
                break;
            visited.add(reference);
            const row = (await this.db.prepare("SELECT body FROM messages WHERE server=? AND channel=? AND id=?")
                .get(message.server, message.channel, reference));
            if (!row)
                break;
            const item = (await this.namedMessage(parseMessage(JSON.parse(String(row.body)))));
            if (!seen.has(item.id))
                selected.unshift(item);
            seen.add(item.id);
            reference = item.replyTo;
        }
        return selected;
    }
    async history(taskKey: string): Promise<readonly PromptItem[]> {
        const context = await (await this.taskContext(taskKey));
        return [...(context.checkpoint ? [context.checkpoint] : []), ...context.entries.map(entry => entry.item)];
    }
    async historyArchive(taskKey: string): Promise<PromptItem[]> {
        return (await this.db.prepare("SELECT item FROM task_history WHERE task_key=? ORDER BY sequence").all(taskKey)).map(row => JSON.parse(String(row.item)) as PromptItem);
    }
    async taskContext(taskKey: string): Promise<TaskContext> {
        const saved = (await this.db.prepare("SELECT * FROM task_checkpoints WHERE task_key=? AND valid=1 ORDER BY sequence DESC LIMIT 1").get(taskKey));
        const entries = (await this.db.prepare("SELECT sequence,item FROM task_history WHERE task_key=? AND valid=1 AND sequence>? ORDER BY sequence")
            .all(taskKey, saved ? Number(saved.through_sequence) : 0)).map(row => ({ sequence: Number(row.sequence), item: JSON.parse(String(row.item)) as PromptItem }));
        return { checkpoint: saved ? JSON.parse(String(saved.item)) as PromptItem : null, entries };
    }
    async checkpoint(taskKey: string, through: number, item: PromptItem, runId: string): Promise<void> {
        (await this.db.prepare("INSERT INTO task_checkpoints(task_key,through_sequence,item,run_id) VALUES(?,?,?,?)").run(taskKey, through, JSON.stringify(item), runId));
    }
    async finishToolRun(runId: string, text: string): Promise<void> {
        (await this.db.prepare("UPDATE runs SET status='tool_calls',result=? WHERE id=?").run(text, runId));
    }
    async agentTurns(message: Message): Promise<AgentTurn[]> {
        if ((await this.db.prepare("SELECT 1 FROM agent_turns WHERE server=? AND message_id=? AND valid=0").get(message.server, message.id)))
            throw new Error("Tool context was invalidated; submit a new request");
        return (await this.db.prepare("SELECT * FROM agent_turns WHERE server=? AND message_id=? AND valid=1 ORDER BY sequence")
            .all(message.server, message.id)).map(row => ({ id: String(row.id), text: String(row.text), calls: JSON.parse(String(row.calls)), results: JSON.parse(String(row.results)), version: Number(row.version) }));
    }
    async addAgentTurn(message: Message, text: string, calls: ToolCall[]): Promise<AgentTurn> {
        const version = Number((await this.db.prepare("SELECT version FROM context_versions WHERE server=? AND channel=?").get(message.server, message.channel))?.version ?? 0);
        const turn: AgentTurn = { id: randomUUID(), text, calls, results: {}, version };
        (await this.db.prepare("INSERT INTO agent_turns(id,server,message_id,text,calls,results,version) VALUES(?,?,?,?,?,?,?)")
            .run(turn.id, message.server, message.id, text, JSON.stringify(calls), "{}", version));
        return turn;
    }
    async agentResult(turnId: string, index: number, result: ToolOutput): Promise<void> {
        (await this.db.prepare("UPDATE agent_turns SET results=json_set(results,?,json(?)) WHERE id=?").run(`$."${index}"`, JSON.stringify(result), turnId));
        const turn = (await this.db.prepare("SELECT server,message_id FROM agent_turns WHERE id=?").get(turnId))!;
        const version = (await this.db.prepare(`SELECT coalesce(v.version,0) AS version FROM messages m LEFT JOIN context_versions v ON v.server=m.server AND v.channel=m.channel WHERE m.server=? AND m.id=?`).get(turn.server!, turn.message_id!));
        if (version)
            (await this.db.prepare("UPDATE agent_turns SET version=? WHERE server=? AND message_id=? AND valid=1").run(Number(version.version), turn.server!, turn.message_id!));
    }
    async partialReply(message: Message): Promise<string | undefined> {
        const run = (await this.db.prepare(`SELECT id FROM runs WHERE status IN ('failed','interrupted') AND json_extract(message,'$.server')=?
      AND json_extract(message,'$.id')=? AND json_extract(message,'$.text')=? AND json_extract(message,'$.author')=?
      AND json_extract(prompt,'$.purpose')='reply' AND context_version=? ORDER BY rowid DESC LIMIT 1`)
            .get(message.server, message.id, message.text, message.author, await (await this.contextVersion(message.server, message.channel))));
        if (!run)
            return undefined;
        return (await this.db.prepare("SELECT payload FROM events WHERE run_id=? AND kind='text' ORDER BY sequence").all(run.id!)).map(row => String(JSON.parse(String(row.payload)).text)).join("") || undefined;
    }
    async recordHarness(message: {
        server: string;
        id: string;
    }, state: HarnessState, event: HarnessEvent): Promise<void> {
        (await this.db.prepare("INSERT INTO harness_events(server,message_id,state,event) VALUES(?,?,?,?)").run(message.server, message.id, JSON.stringify(state), JSON.stringify(event)));
    }
    async harnessState(server: string, id: string): Promise<HarnessState | undefined> {
        const row = (await this.db.prepare("SELECT state FROM harness_events WHERE server=? AND message_id=? ORDER BY sequence DESC LIMIT 1").get(server, id));
        return row ? JSON.parse(String(row.state)) as HarnessState : undefined;
    }
    async startRun(runId: string, message: Message, prompt: Prompt): Promise<void> {
        (await this.db.prepare("INSERT INTO runs(id,message,prompt,status,result,context_version) VALUES(?,?,?,?,NULL,?)")
            .run(runId, JSON.stringify(message), JSON.stringify(prompt), "running", await (await this.contextVersion(message.server, message.channel))));
    }
    async appendEvent(runId: string, sequence: number, event: ModelEvent): Promise<void> {
        (await this.db.prepare("INSERT INTO events VALUES(?,?,?,?)")
            .run(runId, sequence, event.kind, JSON.stringify(event.payload)));
    }
    async complete(runId: string, taskKey: string | undefined, inputs: readonly PromptItem[], text: string): Promise<void> {
        (await this.db.exec("BEGIN IMMEDIATE"));
        try {
            if (taskKey) {
                const insert = this.db.prepare("INSERT INTO task_history(task_key,item) VALUES(?,?)");
                for (const item of [...inputs, { role: "assistant", content: text }]) {
                    (await insert.run(taskKey, JSON.stringify(item)));
                }
            }
            (await this.db.prepare("UPDATE runs SET status='completed',result=? WHERE id=?").run(text, runId));
            const run = (await this.db.prepare("SELECT message,prompt,context_version FROM runs WHERE id=?").get(runId))!;
            const message = parseMessage(JSON.parse(String(run.message)));
            if ([undefined, "reply"].includes(JSON.parse(String(run.prompt)).purpose)) {
                (await this.db.prepare("UPDATE jobs SET status='sending',reply=? WHERE server=? AND message_id=? AND status='running'")
                    .run(JSON.stringify({ runId, text, contextVersion: Number(run.context_version) }), message.server, message.id));
            }
            (await this.db.exec("COMMIT"));
        }
        catch (error) {
            (await this.db.exec("ROLLBACK"));
            throw error;
        }
    }
    async fail(runId: string, error: string): Promise<void> {
        (await this.db.prepare("UPDATE runs SET status='failed',result=? WHERE id=?").run(error, runId));
    }
    async llmUsage(server: string): Promise<{
        requests: number;
        input: number;
        output: number;
        cached: number;
    }> {
        const row = (await this.db.prepare(`SELECT count(*) AS requests,coalesce(sum(json_extract(e.payload,'$.prompt_tokens')),0) AS input,
      coalesce(sum(json_extract(e.payload,'$.completion_tokens')),0) AS output,
      coalesce(sum(json_extract(e.payload,'$.prompt_tokens_details.cached_tokens')),0) AS cached
      FROM events e JOIN runs r ON r.id=e.run_id WHERE e.kind='usage' AND json_extract(r.message,'$.server')=?`).get(server))!;
        return { requests: Number(row.requests), input: Number(row.input), output: Number(row.output), cached: Number(row.cached) };
    }
    async canonicalMessage(server: string, id: string): Promise<Message | undefined> {
        const row = (await this.db.prepare("SELECT body FROM messages WHERE server=? AND id=?").get(server, id));
        return row ? parseMessage(JSON.parse(String(row.body))) : undefined;
    }
    async events(runId: string): Promise<ModelEvent[]> {
        return (await this.db.prepare("SELECT kind,payload FROM events WHERE run_id=? ORDER BY sequence")
            .all(runId)).map(row => ({ kind: row.kind, payload: JSON.parse(String(row.payload)) }) as ModelEvent);
    }
    async close(): Promise<void> { (await this.db.close()); }
    async finishIndexing(): Promise<void> { await this.indexTail; }
    stopIndexing(): void { this.indexingStopped = true; }
    private job(row: Record<string, unknown>): Job {
        return { id: String(row.id), message: parseMessage(JSON.parse(String(row.message))), status: row.status as Job["status"], reply: row.reply ? JSON.parse(String(row.reply)) : null, attempts: Number(row.attempts), error: row.error === null ? null : String(row.error) };
    }
    async enqueueJob(message: Message): Promise<Job> {
        if (message.authorName)
            (await this.identifyAuthor(message.server, message.author, [message.authorName, ...(message.authorAliases ?? [])], message.isBot, message.authorIdentity));
        if ((await this.db.prepare("SELECT 1 FROM message_tombstones WHERE server=? AND id=?").get(message.server, message.id)))
            throw new Error("Source was deleted or invalidated");
        (await this.db.exec("BEGIN IMMEDIATE"));
        let added = false;
        try {
            const result = (await this.db.prepare("INSERT OR IGNORE INTO messages(server,id,channel,body) VALUES(?,?,?,?)").run(message.server, message.id, message.channel, JSON.stringify(message)));
            added = result.changes === 1;
            (await this.db.prepare("INSERT OR IGNORE INTO jobs(id,server,channel,message_id,message,status) VALUES(?,?,?,?,?,'pending')").run(randomUUID(), message.server, message.channel, message.id, JSON.stringify(message)));
            (await this.db.exec("COMMIT"));
        }
        catch (error) {
            (await this.db.exec("ROLLBACK"));
            throw error;
        }
        if (added)
            this.queueIndex(message);
        return this.job((await this.db.prepare("SELECT * FROM jobs WHERE server=? AND message_id=?").get(message.server, message.id))!);
    }
    async acquireWorker(server: string, owner: string, expires: number): Promise<boolean> {
        const result = (await this.db.prepare(`INSERT INTO worker_leases VALUES(?,?,?) ON CONFLICT(server) DO UPDATE SET owner=excluded.owner,expires=excluded.expires
      WHERE worker_leases.owner=excluded.owner OR worker_leases.expires<?`).run(server, owner, expires, Date.now()));
        return result.changes === 1;
    }
    async releaseWorker(server: string, owner: string): Promise<void> { (await this.db.prepare("DELETE FROM worker_leases WHERE server=? AND owner=?").run(server, owner)); }
    async recoverJobs(server: string): Promise<void> {
        (await this.db.prepare("UPDATE runs SET status='interrupted' WHERE status='running' AND json_extract(message,'$.server')=?").run(server));
        (await this.db.prepare("UPDATE jobs SET status=CASE WHEN reply IS NULL THEN 'pending' ELSE 'ready' END WHERE server=? AND status IN ('running','sending')").run(server));
    }
    async claimJob(server: string): Promise<Job | undefined> {
        (await this.db.exec("BEGIN IMMEDIATE"));
        try {
            const row = (await this.db.prepare(`SELECT * FROM jobs j WHERE server=? AND status IN ('pending','ready') AND available_at<=? AND NOT EXISTS
        (SELECT 1 FROM jobs active WHERE active.server=j.server AND active.channel=j.channel AND active.id<>j.id AND
          (active.status IN ('running','sending') OR (active.status IN ('pending','ready') AND active.sequence<j.sequence))) ORDER BY sequence LIMIT 1`).get(server, Date.now()));
            if (row)
                (await this.db.prepare("UPDATE jobs SET status=?,attempts=attempts+1 WHERE id=?").run(row.reply ? "sending" : "running", row.id!));
            (await this.db.exec("COMMIT"));
            return row ? this.job(row) : undefined;
        }
        catch (error) {
            (await this.db.exec("ROLLBACK"));
            throw error;
        }
    }
    async readyJob(id: string, reply: import("../domain.js").Reply): Promise<void> { (await this.db.prepare("UPDATE jobs SET status='sending',reply=? WHERE id=? AND status='running'").run(JSON.stringify(reply), id)); }
    async finishJob(id: string): Promise<void> { (await this.db.prepare("UPDATE jobs SET status='done',error=NULL WHERE id=? AND status<>'cancelled'").run(id)); }
    async retryLater(id: string, at: number): Promise<void> { (await this.db.prepare("UPDATE jobs SET status=CASE WHEN reply IS NULL THEN 'pending' ELSE 'ready' END,available_at=? WHERE id=? AND status<>'cancelled'").run(at, id)); }
    async failJob(id: string, error: string, blocked: boolean): Promise<void> {
        (await this.db.prepare("UPDATE jobs SET status=?,error=? WHERE id=? AND status<>'cancelled'").run(blocked ? "blocked" : "failed", error.slice(0, 1000), id));
    }
    async hasBlocked(server: string, channel: string): Promise<boolean> { return Boolean((await this.db.prepare("SELECT 1 FROM jobs WHERE server=? AND channel=? AND status='blocked' LIMIT 1").get(server, channel))); }
    async hasPendingOther(server: string, channel: string, messageId: string): Promise<boolean> { return Boolean((await this.db.prepare("SELECT 1 FROM jobs WHERE server=? AND channel=? AND message_id<>? AND status='pending' LIMIT 1").get(server, channel, messageId))); }
    async jobs(server: string, channel: string): Promise<Job[]> {
        return (await this.db.prepare("SELECT * FROM jobs WHERE server=? AND channel=? ORDER BY sequence DESC LIMIT 20").all(server, channel)).map(row => this.job(row));
    }
    async retryJob(server: string, channel: string, id: string): Promise<boolean> {
        return (await this.db.prepare("UPDATE jobs SET status=CASE WHEN reply IS NULL THEN 'pending' ELSE 'ready' END,error=NULL WHERE server=? AND channel=? AND id=? AND status IN ('failed','blocked')").run(server, channel, id)).changes === 1;
    }
    async operation(id: string): Promise<ToolOperation | undefined> {
        const row = (await this.db.prepare("SELECT * FROM tool_operations WHERE id=?").get(id));
        return row ? { id, name: String(row.name), args: JSON.parse(String(row.args)) as ToolArgs, resource: row.resource === null ? null : String(row.resource), status: row.status as ToolOperation["status"], result: row.result === null ? null : String(row.result) } : undefined;
    }
    async blockingOperation(resource: string, exceptId: string): Promise<string | undefined> {
        const row = (await this.db.prepare("SELECT id FROM tool_operations WHERE resource=? AND id<>? AND status='started' LIMIT 1").get(resource, exceptId));
        return row ? String(row.id) : undefined;
    }
    async beginOperation(context: ToolContext, name: string, args: ToolArgs): Promise<void> {
        const message = context.message;
        (await this.db.prepare("INSERT INTO tool_operations(id,server,channel,author,message_id,name,args,status,result,created_at,resource) VALUES(?,?,?,?,?,?,?,'started',NULL,?,?)").run(context.operationId, message.server, message.channel, message.author, message.id, name, JSON.stringify(args), Date.now(), context.resource));
    }
    async endOperation(id: string, result: string, failed = false): Promise<void> {
        (await this.db.prepare("UPDATE tool_operations SET status=?,result=? WHERE id=?").run(failed ? "failed" : "done", result, id));
    }
    async delivery(id: string): Promise<{
        message: Message;
        content: string;
        createdAt: number;
        result: Message | null;
    } | undefined> {
        const row = (await this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id));
        return row ? { message: parseMessage(JSON.parse(String(row.message))), content: String(row.content), createdAt: Number(row.created_at), result: row.result ? parseMessage(JSON.parse(String(row.result))) : null } : undefined;
    }
    async prepareDelivery(id: string, message: Message, content: string): Promise<void> {
        (await this.db.prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?,NULL)").run(id, JSON.stringify(message), content, Date.now()));
    }
    async finishDelivery(id: string, result: Message): Promise<void> { (await this.db.prepare("UPDATE deliveries SET result=? WHERE id=?").run(JSON.stringify(result), id)); }
    setting(server: string, key: string): unknown { return structuredClone(this.settingsCache.get(JSON.stringify([server,key]))); }
    async setSetting(server: string, key: string, value: Json): Promise<void> {
        (await this.db.prepare("INSERT OR REPLACE INTO settings VALUES(?,?,?)").run(server, key, JSON.stringify(value)));
        this.settingsCache.set(JSON.stringify([server,key]),structuredClone(value));
    }
    async reindex(server: string, channels: readonly string[]): Promise<number> {
        if (!this.embeddings || !channels.length)
            return 0;
        const rows = (await this.db.prepare(`SELECT m.body FROM messages m WHERE m.server=?
      AND m.channel IN (${channels.map(() => "?").join(",")}) AND NOT EXISTS
      (SELECT 1 FROM embeddings e WHERE e.server=m.server AND e.message_id=m.id AND e.model=?)`)
            .all(server, ...channels, this.embeddings.model));
        for (const row of rows)
            this.queueIndex(parseMessage(JSON.parse(String(row.body))));
        return rows.length;
    }
    async purgeUnconfigured(server: string, allowed: readonly string[]): Promise<void> {
        const rows = (await this.db.prepare("SELECT id,channel FROM messages WHERE server=?").all(server));
        for (const row of rows) {
            if (allowed.includes(String(row.channel)))
                continue;
            (await this.invalidateSource(server, String(row.id)));
            (await this.db.prepare("DELETE FROM messages WHERE server=? AND id=?").run(server, String(row.id)));
            (await this.invalidate(server, String(row.channel)));
        }
        const histories = (await this.db.prepare("SELECT key FROM settings WHERE server=? AND key LIKE 'history:%'").all(server));
        for (const row of histories) {
            if (!allowed.includes(String(row.key).slice(8))) {
                await this.db.prepare("DELETE FROM settings WHERE server=? AND key=?").run(server, String(row.key));
                this.settingsCache.delete(JSON.stringify([server,String(row.key)]));
            }
        }
        const jobs = (await this.db.prepare("SELECT id,channel FROM jobs WHERE server=? AND status NOT IN ('done','cancelled')").all(server));
        for (const row of jobs)
            if (!allowed.includes(String(row.channel)))
                (await this.db.prepare("UPDATE jobs SET status='cancelled',error='Channel disabled' WHERE id=?").run(String(row.id)));
    }
    private queueIndex(message: Message): void {
        if (this.indexingStopped || !this.embeddings || !message.text.trim())
            return;
        this.indexTail = this.indexTail.then(() => this.indexingStopped ? undefined : this.indexMessage(message)).catch((error: unknown) => {
            const failure = error as { name?: string; code?: string; status?: number; cause?: { code?: string }; stack?: string };
            console.error("Embedding indexing failed; keyword retrieval remains available.", {
                name: failure?.name, code: failure?.code, status: failure?.status,
                cause: failure?.cause?.code, frames: failure?.stack?.split("\n").slice(1, 4),
            });
        });
    }
    private async indexMessage(message: Message): Promise<void> {
            const existing = (await this.db.prepare("SELECT 1 FROM embeddings WHERE server=? AND message_id=? AND model=?").get(message.server, message.id, this.embeddings!.model));
            if (existing)
                return;
            const vector = await this.embed(message, "index");
            const current = (await this.db.prepare("SELECT body FROM messages WHERE server=? AND id=?").get(message.server, message.id));
            if (!current || parseMessage(JSON.parse(String(current.body))).text !== message.text)
                return;
            (await this.db.prepare("INSERT OR REPLACE INTO embeddings VALUES(?,?,?,?)")
                .run(message.server, message.id, this.embeddings!.model, JSON.stringify(vector)));
    }

    async indexStats(server: string, channel: string): Promise<{
        messages: number;
        vectors: number;
        oldest: number | null;
        newest: number | null;
        usage: {
            model: string;
            purpose: string;
            requests: number;
            tokens: number;
            unknown: number;
        }[];
    }> {
        const row = (await this.db.prepare("SELECT count(*) AS count,min(json_extract(body,'$.timestamp')) AS oldest,max(json_extract(body,'$.timestamp')) AS newest FROM messages WHERE server=? AND channel=?").get(server, channel))!;
        const vectors = (await this.db.prepare("SELECT count(*) AS count FROM embeddings e JOIN messages m ON m.server=e.server AND m.id=e.message_id WHERE m.server=? AND m.channel=? AND e.model=?").get(server, channel, this.embeddings?.model ?? ""))!;
        const usage = (await this.db.prepare("SELECT * FROM embedding_usage WHERE server=? AND channel=?").all(server, channel)).map(value => ({ model: String(value.model), purpose: String(value.purpose), requests: Number(value.requests), tokens: Number(value.tokens), unknown: Number(value.unknown_tokens) }));
        return { messages: Number(row.count), vectors: Number(vectors.count), oldest: row.oldest === null ? null : Number(row.oldest), newest: row.newest === null ? null : Number(row.newest), usage };
    }
    private async embed(message: Message, purpose: "index" | "query"): Promise<readonly number[]> {
        const result = this.embeddings!.embedWithUsage
            ? await this.embeddings!.embedWithUsage(message.text)
            : { vector: await this.embeddings!.embed(message.text), tokens: null };
        (await this.db.prepare(`INSERT INTO embedding_usage VALUES(?,?,?,?,1,?,?)
      ON CONFLICT(server,channel,model,purpose) DO UPDATE SET requests=requests+1,tokens=tokens+excluded.tokens,unknown_tokens=unknown_tokens+excluded.unknown_tokens`)
            .run(message.server, message.channel, this.embeddings!.model, purpose, result.tokens ?? 0, result.tokens === null ? 1 : 0));
        return result.vector;
    }
    async remember(message: Message, content: string): Promise<MemoryRecord> {
        if (!content.trim() || content.length > 2000)
            throw new Error("Memory must contain 1–2000 characters");
        if (!(await this.db.prepare("SELECT 1 FROM messages WHERE server=? AND channel=? AND id=?")
            .get(message.server, message.channel, message.id)))
            throw new Error("Memory source is unavailable");
        const memory: MemoryRecord = {
            id: randomUUID(), server: message.server, channel: message.channel, author: message.author,
            content: content.trim(), sourceIds: [message.id], status: "active",
        };
        (await this.db.exec("BEGIN IMMEDIATE"));
        try {
            (await this.db.prepare("INSERT INTO memories VALUES(?,?,?,?,?,?,?)")
                .run(memory.id, memory.server, memory.channel, memory.author, memory.content, memory.status, Date.now()));
            (await this.db.prepare("INSERT INTO memory_sources VALUES(?,?,?)").run(memory.id, memory.server, message.id));
            (await this.bumpVersion(message.server, message.channel));
            (await this.db.exec("COMMIT"));
        }
        catch (error) {
            (await this.db.exec("ROLLBACK"));
            throw error;
        }
        return memory;
    }
    async memories(server: string, channel: string): Promise<readonly MemoryRecord[]> {
        return (await Promise.all((await this.db.prepare(`SELECT * FROM memories m WHERE server=? AND channel=? AND status='active'
      AND NOT EXISTS(SELECT 1 FROM memory_sources s WHERE s.memory_id=m.id AND NOT EXISTS
        (SELECT 1 FROM messages x WHERE x.server=s.server AND x.id=s.message_id))
      ORDER BY created_at DESC, rowid DESC`).all(server, channel)).map(async (row) => ({
            id: String(row.id), server, channel, author: String(row.author), content: String(row.content), status: "active",
            sourceIds: (await this.db.prepare("SELECT message_id FROM memory_sources WHERE memory_id=?")
                .all(String(row.id))).map(source => String(source.message_id)),
        }))));
    }
    async forget(server: string, channel: string, id: string, actor: string): Promise<boolean> {
        const result = (await this.db.prepare("UPDATE memories SET status='forgotten' WHERE id=? AND server=? AND channel=? AND author=? AND status='active'")
            .run(id, server, channel, actor));
        if (result.changes) {
            for (const row of (await this.db.prepare("SELECT message_id FROM memory_sources WHERE memory_id=?").all(id))) {
                const source = String(row.message_id);
                (await this.invalidateSource(server, source));
                (await this.db.prepare("DELETE FROM messages WHERE server=? AND id=?").run(server, source));
                (await this.db.prepare("INSERT OR IGNORE INTO message_tombstones VALUES(?,?)").run(server, source));
            }
            (await this.invalidate(server, channel));
        }
        return Boolean(result.changes);
    }
    async retrieve(message: Message, limit: number): Promise<readonly Evidence[]> {
        const evidence: Evidence[] = [];
        // Resolve people from scoped canonical authors, never from generated descriptions.
        const directory = (await this.db.prepare(`SELECT DISTINCT d.author,d.names,d.bot FROM author_directory d JOIN messages m
      ON m.server=d.server AND json_extract(m.body,'$.author')=d.author WHERE m.server=? AND m.channel=?`).all(message.server, message.channel));
        for (const row of directory) {
            const aliases = (await this.profile(message.server, String(row.author))).fields.filter(item => ["real_name", "nickname", "nicknames", "aliases"].includes(item.field)).flatMap(item => typeof item.value === "string" ? [item.value] : Array.isArray(item.value) ? item.value.filter((value): value is string => typeof value === "string") : []);
            row.names = JSON.stringify([...JSON.parse(String(row.names)), ...aliases]);
        }
        const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
        const match = (text: string) => directory.filter(row => !row.bot && (text.includes(`<@${row.author}>`) || text.includes(`<@!${row.author}>`) ||
            (JSON.parse(String(row.names)) as string[]).some(name => normalized(name).length > 2 && (` ${normalized(text)} `).includes(` ${normalized(name)} `))));
        let targets = match(message.text);
        const recent = (await this.canonicalMessage(message.server, message.id)) ? await (await this.context(message, 12)) : [];
        if (!targets.length && /\b(he|him|his|they|them|their|other|more|quotes?)\b/i.test(message.text)) {
            for (const prior of [...recent].reverse()) {
                if (prior.author !== message.author || prior.isBot)
                    continue;
                targets = match(prior.text);
                if (targets.length)
                    break;
            }
        }
        const personQuery = /\b(said|say|quotes?)\b/i.test(message.text) || /^I meant\b/i.test(message.text);
        if (targets.length === 1 && personQuery) {
            const target = targets[0]!, count = Math.min(20, Math.max(limit, Number(message.text.match(/\b(\d{1,2})\b/)?.[1] ?? (/\bten\b/i.test(message.text) ? 10 : limit))));
            const rows = (await this.db.prepare(`SELECT body FROM messages WHERE server=? AND channel=? AND json_extract(body,'$.author')=? AND id<>?
        ORDER BY coalesce(json_extract(body,'$.timestamp'),sequence) DESC LIMIT ?`).all(message.server, message.channel, String(target.author), message.id, count));
            evidence.push({ kind: "retrieval", targetAuthor: String(target.author), author: String(target.author), sourceIds: [], content: `Resolved person: ${String(target.names)}; exact author ID ${target.author}. These are stored messages by this person, not a claim about the whole channel's history.` });
            for (const row of rows) {
                const item = parseMessage(JSON.parse(String(row.body)));
                evidence.push({ kind: "message", content: item.text, author: item.author, authorName: (JSON.parse(String(target.names)) as string[])[0] ?? String(target.author), sourceIds: [item.id], sourceUrl: `https://discord.com/channels/${message.server}/${message.channel}/${item.id}` });
            }
            return evidence;
        }
        if (personQuery)
            return [{ kind: "retrieval", author: "system", sourceIds: [], content: targets.length > 1 ? "Person name is ambiguous. Ask which member the requester means before attributing messages." : "Could not resolve the requested person from known channel author names. Ask for their Discord mention. Do not attribute unrelated recent chat to them." }];
        const terms = searchTerms(message.text);
        const notes = await (await this.memories(message.server, message.channel));
        const relevant = [...notes].sort((a, b) => {
            const score = (memory: MemoryRecord) => terms.filter(term => memory.content.toLowerCase().includes(term)).length;
            return score(b) - score(a);
        }).slice(0, Math.min(limit, 4));
        for (const memory of relevant)
            evidence.push({ kind: "memory", content: memory.content, author: memory.author, sourceIds: memory.sourceIds });
    const recalled=await this.searchHistory({server:message.server,channel:message.channel,query:message.text,mode:'hybrid',limit,excludeId:message.id});
    const selected=new Map(recalled.messages.map(item=>[item.id,item]));
        for (const item of selected.values()) {
            if (evidence.length >= limit)
                break;
            evidence.push({ kind: "message", content: item.text, author: item.author, sourceIds: [item.id] });
        }
        return evidence;
    }
    async recordSources(runId: string, server: string, sourceIds: readonly string[]): Promise<void> {
        const insert = this.db.prepare("INSERT OR IGNORE INTO run_sources VALUES(?,?,?)");
        for (const id of sourceIds)
            (await insert.run(runId, server, id));
        const run = (await this.db.prepare("SELECT message FROM runs WHERE id=?").get(runId));
        if (!run)
            return;
        const message = parseMessage(JSON.parse(String(run.message)));
        if (message.taskId) {
            const previous = (await this.db.prepare(`SELECT DISTINCT s.message_id FROM run_sources s JOIN runs r ON r.id=s.run_id
        JOIN messages m ON m.server=s.server AND m.id=s.message_id
        WHERE r.status='completed' AND s.server=? AND json_extract(r.message,'$.channel')=? AND json_extract(r.message,'$.taskId')=?`)
                .all(server, message.channel, message.taskId));
            for (const row of previous)
                (await insert.run(runId, server, String(row.message_id)));
        }
    }
    async linkOutput(message: Message, runId: string | undefined, sourceId: string): Promise<void> {
        const sources = runId ? (await this.db.prepare("SELECT message_id FROM run_sources WHERE run_id=? AND server=?")
            .all(runId, message.server)).map(row => String(row.message_id)) : [sourceId];
        const insert = this.db.prepare("INSERT OR IGNORE INTO source_dependents VALUES(?,?,?)");
        for (const source of sources.length ? sources : [sourceId])
            (await insert.run(message.server, source, message.id));
    }
    private async bumpVersion(server: string, channel: string): Promise<void> {
        (await this.db.prepare("INSERT INTO context_versions VALUES(?,?,1) ON CONFLICT(server,channel) DO UPDATE SET version=version+1")
            .run(server, channel));
    }
    private async invalidateSource(server: string, id: string, seen = new Set<string>()): Promise<void> {
        if (seen.has(id))
            return;
        seen.add(id);
        (await this.db.prepare("UPDATE memories SET status='invalidated' WHERE status='active' AND id IN (SELECT memory_id FROM memory_sources WHERE server=? AND message_id=?)")
            .run(server, id));
        (await this.db.prepare("UPDATE profile_events SET valid=0 WHERE server=? AND id IN (SELECT e.id FROM profile_events e,json_each(e.sources) s WHERE e.server=? AND s.value=?)").run(server, server, id));
        (await this.db.prepare("DELETE FROM embeddings WHERE server=? AND message_id=?").run(server, id));
        const dependents = (await this.db.prepare("SELECT output_id FROM source_dependents WHERE server=? AND source_id=?").all(server, id));
        for (const dependent of dependents) {
            const output = String(dependent.output_id);
            (await this.invalidateSource(server, output, seen));
            (await this.db.prepare("DELETE FROM messages WHERE server=? AND id=?").run(server, output));
            (await this.db.prepare("INSERT OR IGNORE INTO message_tombstones VALUES(?,?)").run(server, output));
        }
    }
    async contextVersion(server: string, channel: string): Promise<number> {
        const row = (await this.db.prepare("SELECT version FROM context_versions WHERE server=? AND channel=?").get(server, channel));
        return Number(row?.version ?? 0);
    }
    taskThreads(server: string): { thread: string; parent: string }[] { return this.threadsCache.filter(task=>task.server===server).map(({thread,parent})=>({thread,parent})); }
    async registerTask(server: string, thread: string, parent: string, sourceId?: string): Promise<void> {
        (await this.db.prepare("INSERT OR IGNORE INTO task_threads(server,thread,parent,source_id) VALUES(?,?,?,?)").run(server, thread, parent, sourceId ?? null));
        if (!this.threadsCache.some(task=>task.server===server && task.thread===thread)) this.threadsCache.push({server,thread,parent});
    }
    async taskForSource(server: string, sourceId: string): Promise<string | undefined> {
        const row = (await this.db.prepare("SELECT thread FROM task_threads WHERE server=? AND source_id=?").get(server, sourceId));
        return row ? String(row.thread) : undefined;
    }
    async revise(message: Message): Promise<void> {
        const row = (await this.db.prepare("SELECT body FROM messages WHERE server=? AND id=? AND channel=?")
            .get(message.server, message.id, message.channel));
        if (!row)
            return;
        const previous = parseMessage(JSON.parse(String(row.body)));
        // Discord also emits updates for embeds; unchanged text is not a correction.
        if (previous.text === message.text && previous.replyTo === message.replyTo)
            return;
        (await this.invalidateSource(message.server, message.id));
        (await this.db.prepare("UPDATE messages SET body=? WHERE server=? AND id=? AND channel=?")
            .run(JSON.stringify(message), message.server, message.id, message.channel));
        (await this.invalidate(message.server, message.channel));
        this.queueIndex(message);
    }
    async remove(server: string, channel: string, id: string): Promise<void> {
        (await this.invalidateSource(server, id));
        (await this.db.prepare("INSERT OR IGNORE INTO message_tombstones VALUES(?,?)").run(server, id));
        const result = (await this.db.prepare("DELETE FROM messages WHERE server=? AND channel=? AND id=?").run(server, channel, id));
        if (result.changes)
            (await this.invalidate(server, channel));
    }
    private async invalidate(server: string, channel: string): Promise<void> {
        // Keep original history and reasoning logs. Only remove them from future prompt assembly.
        (await this.db.prepare("UPDATE task_history SET valid=0 WHERE json_extract(task_key,'$[0]')=? AND json_extract(task_key,'$[1]')=?")
            .run(server, channel));
        (await this.db.prepare("UPDATE task_checkpoints SET valid=0 WHERE json_extract(task_key,'$[0]')=? AND json_extract(task_key,'$[1]')=?").run(server, channel));
        (await this.db.prepare("UPDATE agent_turns SET valid=0 WHERE server=? AND message_id IN (SELECT id FROM messages WHERE server=? AND channel=?)").run(server, server, channel));
        (await this.bumpVersion(server, channel));
        for (const task of (this.taskThreads(server))) {
            if (task.parent === channel)
                (await this.invalidate(server, task.thread));
        }
    }
}
