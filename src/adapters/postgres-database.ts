import { AsyncLocalStorage } from "node:async_hooks";
import { Client, types } from "pg";
import { readFileSync } from "node:fs";

// Millisecond timestamps and counters fit exactly in JS safe integers.
types.setTypeParser(20, value => { const number = Number(value); if (!Number.isSafeInteger(number)) throw new Error("Database integer exceeds safe range"); return number; });
export type Row = Record<string, any>;
export class PostgresDatabase {
  private constructor(private readonly client: Client) {}
  static async connect(url: string): Promise<PostgresDatabase> {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 15000 });
    await client.connect();
    try { await client.query(readFileSync(new URL("./postgres-schema.sql", import.meta.url), "utf8")); }
    catch(error) { await client.end(); throw error; }
    return new PostgresDatabase(client);
  }
  prepare(sql: string) {
    const query = async (values: unknown[]) => {
      const translated = postgresSql(sql, values);
      return this.client.query(translated.sql, translated.values);
    };
    return {
      get: async (...values: unknown[]): Promise<Row | undefined> => (await query(values)).rows[0],
      all: async (...values: unknown[]): Promise<Row[]> => (await query(values)).rows,
      run: async (...values: unknown[]): Promise<{ changes: number }> => ({ changes: (await query(values)).rowCount ?? 0 }),
    };
  }
  async exec(sql: string): Promise<void> { await this.client.query(sql === "BEGIN IMMEDIATE" ? "BEGIN" : sql); }
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
    else if(table === "embeddings") sql += " ON CONFLICT(server,message_id,model) DO UPDATE SET vector=excluded.vector";
    else throw new Error(`Unsupported replacement table ${table}`);
  }
  sql = sql.replace("SET requests=requests+1,tokens=tokens+excluded.tokens,unknown_tokens=unknown_tokens+excluded.unknown_tokens", "SET requests=embedding_usage.requests+1,tokens=embedding_usage.tokens+excluded.tokens,unknown_tokens=embedding_usage.unknown_tokens+excluded.unknown_tokens");
  sql = sql.replace("SET version=version+1", "SET version=context_versions.version+1");
  let index=0;
  sql=sql.replace(/\?/g, () => `$${++index}`);
  return { sql, values };
}

// A transaction and its nested repository calls share one connection. Background
// indexing acquires its own turn after the initiating operation has finished.
export function serializeStore<T extends object>(store: T): T {
  const scope = new AsyncLocalStorage<{ active: boolean }>();
  let tail = Promise.resolve();
  return new Proxy(store, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== "function" || value.constructor.name !== "AsyncFunction" || property === "finishIndexing") return typeof value === "function" ? value.bind(receiver) : value;
    return async (...args: unknown[]) => {
      if(property !== "indexMessage" && scope.getStore()?.active) return value.apply(receiver,args);
      const previous=tail; let release!: () => void;
      tail=new Promise<void>(resolve=>{release=resolve;}); await previous;
      const current={active:true};
      try { return await scope.run(current,()=>value.apply(receiver,args)); }
      finally { current.active=false;release(); }
    };
  } });
}
