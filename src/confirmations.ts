import type { Json } from "./domain.js";
import type { RecordStore } from "./records.js";

export const CONFIRM_RECORD = "tool-confirm";

/** Saves a pending confirmation. A record that is still pending is kept, so its Confirm and Cancel buttons still work. A done record is replaced. Retries a revision conflict, and throws rather than losing the record. */
export async function saveConfirmation(store: RecordStore, server: string, operationId: string, value: Json): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await store.record(server, CONFIRM_RECORD, operationId);
    if (previous && (previous.value as Record<string, Json> | undefined)?.done !== true) return;
    if (await store.putRecord(server, CONFIRM_RECORD, operationId, value, previous?.revision ?? 0)) return;
  }
  throw new Error("Confirmation record kept changing while it was saved");
}
