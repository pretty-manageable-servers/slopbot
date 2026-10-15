import { AsyncLocalStorage } from "node:async_hooks";
import { requestTimings } from "../request-timing.js";
import { Client, types } from "pg";
import { readFileSync } from "node:fs";
import { errorContext } from "../errors.js";

// PostgreSQL text/jsonb cannot represent NUL or lone UTF-16 surrogates.
// Decode JSON before repairing it so a literal backslash-u sequence stays literal.
export function postgresValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const cleanText = (text: string) => text.replace(/[\u0000\uD800-\uDFFF]/gu, '\uFFFD');
  const cleanJson = (item: unknown): unknown => {
    if (typeof item === 'string') return cleanText(item);
    if (Array.isArray(item)) return item.map(cleanJson);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, field]) => [cleanText(key), cleanJson(field)]));
    return item;
  };
  if (/\\u(?:0000|d[89a-f][0-9a-f]{2})/i.test(value)) {
    try { return JSON.stringify(cleanJson(JSON.parse(value))); }
    catch { /* Plain text containing escape-like sequences is not JSON. */ }
  }
  return cleanText(value);
}

// Millisecond timestamps and counters fit exactly in JS safe integers.
types.setTypeParser(20, value => { const number = Number(value); if (!Number.isSafeInteger(number)) throw new Error("Database integer exceeds safe range"); return number; });
export type Row = Record<string, any>;
export class PostgresDatabase {
  private constructor(private readonly client: Client) {}
  static async connect(url: string, schema?: string): Promise<PostgresDatabase> {
    if (schema && !/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("Invalid database schema");
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 15000 });
    await client.connect();
    try {
      if (schema) {
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
      }
      // Processes that start together would race on CREATE EXTENSION and table setup, so the setup runs under one lock.
      await client.query("SELECT pg_advisory_lock(hashtextextended('slopbot_schema_setup', 0))");
      try { await client.query(readFileSync(new URL("./postgres-schema.sql", import.meta.url), "utf8")); }
      finally { await client.query("SELECT pg_advisory_unlock(hashtextextended('slopbot_schema_setup', 0))"); }
    }
    catch(error) { await client.end(); throw error; }
    return new PostgresDatabase(client);
  }
  prepare(sql: string) {
    const query = async (values: unknown[]) => {
      const translated = postgresSql(sql, values);
      const operation = sql.trim().split(/\s+/)[0]!.toLowerCase();
      const table = sql.match(/\b(?:FROM|INTO|UPDATE)\s+([a-z_]+)/i)?.[1] ?? "statement";
      try {
        return await requestTimings.wait(`database ${operation} ${table}`, () => this.client.query(translated.sql, translated.values.map(postgresValue)));
      } catch (error) { throw errorContext(error, { stage: `database ${operation} ${table}` }); }
    };
    return {
      get: async (...values: unknown[]): Promise<Row | undefined> => (await query(values)).rows[0],
      all: async (...values: unknown[]): Promise<Row[]> => (await query(values)).rows,
      run: async (...values: unknown[]): Promise<{ changes: number }> => ({ changes: (await query(values)).rowCount ?? 0 }),
    };
  }
  async exec(sql: string): Promise<void> { await requestTimings.wait("database transaction", () => this.client.query(sql === "BEGIN IMMEDIATE" ? "BEGIN" : sql)); }
  async close(): Promise<void> { await this.client.end(); }
}
export function postgresSql(input: string, values: unknown[]): { sql: string; values: unknown[] } {
  let sql = input.replace(/message_search\.text LIKE/g, "message_search.text ILIKE");
  const ignore = /INSERT OR IGNORE/i.test(sql), replace = /INSERT OR REPLACE/i.test(sql);
  sql = sql.replace(/INSERT OR (IGNORE|REPLACE)/i, "INSERT");
  sql = sql.replace(/json_extract\(([^,]+),'([^']+)'\)/g, (_all, column: string, path: string) => {
    const keys = path.startsWith("$[") ? [path.slice(2,-1)] : path.slice(2).split(".");
    const expression = `${column}::jsonb #>> '{${keys.join(",")}}'`;
    return /timestamp|tokens$/.test(path) ? `(${expression})::bigint` : `(${expression})`;
  });
  sql = sql.replace(/json_each\(e.sources\) s/g, "jsonb_array_elements_text(e.sources::jsonb) AS s(value)");
  if (sql.includes("json_set(results")) {
    sql = sql.replace("json_set(results,?,json(?))", "jsonb_set(results::jsonb,?::text[],?::jsonb)::text");
    values = [...values]; values[0] = `{${String(values[0]).match(/\d+/)?.[0]}}`;
  }
  if (ignore) sql += " ON CONFLICT DO NOTHING";
  if (replace) {
    const table = sql.match(/INSERT INTO (\w+)/i)?.[1];
    if (table === "settings") sql += " ON CONFLICT(server,key) DO UPDATE SET value=excluded.value";
    else if(table === "memory_embeddings") sql += " ON CONFLICT(server,memory_id,model) DO UPDATE SET vector=excluded.vector";
    else throw new Error(`Unsupported replacement table ${table}`);
  }
  sql = sql.replace("SET requests=requests+1,tokens=tokens+excluded.tokens,unknown_tokens=unknown_tokens+excluded.unknown_tokens", "SET requests=embedding_usage.requests+1,tokens=embedding_usage.tokens+excluded.tokens,unknown_tokens=embedding_usage.unknown_tokens+excluded.unknown_tokens");
  sql = sql.replace("SET version=version+1", "SET version=context_versions.version+1");
  let index=0;
  sql=sql.replace(/\?/g, () => `$${++index}`);
  return { sql, values };
}

// A transaction and its nested repository calls share one connection. Background
// indexing runs network requests outside the queue and serializes only its SQL.
export function serializeStore<T extends object>(store: T): T {
  const scope = new AsyncLocalStorage<{ active: boolean }>();
  let tail = Promise.resolve();
  return new Proxy(store, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (property === "indexMessage" && typeof value === "function") return (...args: unknown[]) => scope.exit(() => value.apply(receiver, args));
    if (typeof value !== "function" || value.constructor.name !== "AsyncFunction" || property === "finishIndexing") return typeof value === "function" ? value.bind(receiver) : value;
    return async (...args: unknown[]) => {
      if(scope.getStore()?.active) return value.apply(receiver,args);
      const previous=tail; let release!: () => void;
      tail=new Promise<void>(resolve=>{release=resolve;}); await requestTimings.wait("database connection queue", () => previous);
      const current={active:true};
      try { return await scope.run(current,()=>value.apply(receiver,args)); }
      finally { current.active=false;release(); }
    };
  } });
}
