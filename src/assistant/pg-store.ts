import type { PostgresDatabase } from "../adapters/postgres-database.js";
import type { PostgresStore } from "../adapters/postgres.js";
import { AssistantSqlStore } from "./sqlite-store.js";

export class PgAssistantStore extends AssistantSqlStore {
  constructor(db: PostgresDatabase) { super(db); }
}

/** Reads the private handle of a PostgresStore. The adapter stays untouched. */
export function pgAssistantStore(store: PostgresStore): PgAssistantStore {
  return new PgAssistantStore((store as unknown as { db: PostgresDatabase }).db);
}
