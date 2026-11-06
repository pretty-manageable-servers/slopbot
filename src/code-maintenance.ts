import { logError } from "./errors.js";
import type { RecordStore } from "./records.js";
import type { ToolJournal } from "./tools.js";
import { PROGRAM_CODE_KEEP_MS } from "./code-display.js";
import { pruneToolTraces } from "./tool-trace.js";

const PROGRAM_TOOL = "run_tools_code";
const CODE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Deletes program code older than PROGRAM_CODE_KEEP_MS, once an hour. Returns a function that stops the timer. */
export function startCodeMaintenance(store: Pick<ToolJournal, "pruneOperations"> & RecordStore, server: string): () => void {
  const timer = setInterval(() => {
    void pruneToolTraces(store, server).catch(error => logError("tool_trace_prune_failed", error, {}, true));
    void Promise.resolve(store.pruneOperations?.(PROGRAM_TOOL, Date.now() - PROGRAM_CODE_KEEP_MS))
      .catch(error => logError("run_tools_code_prune_failed", error, {}, true));
  }, CODE_PRUNE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
