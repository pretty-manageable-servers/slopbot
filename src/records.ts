import type { Json } from "./domain.js";
export interface AppRecord {
  id: string;
  revision: number;
  value: Json;
}
export interface RecordStore {
  record(
    server: string,
    kind: string,
    id: string,
  ): Promise<AppRecord | undefined>;
  records(server: string, kind: string): Promise<AppRecord[]>;
  putRecord(
    server: string,
    kind: string,
    id: string,
    value: Json,
    expectedRevision: number,
  ): Promise<boolean>;
}
