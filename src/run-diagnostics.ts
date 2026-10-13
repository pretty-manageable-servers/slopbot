import type { Prompt } from './domain.js';
import { runtimeVersion } from './operations-config.js';
import type { RecordStore } from './records.js';

export function promptInventory(prompt: Prompt) {
  const summarize = (items: Prompt['inputs']) => items.map(item => ({ role: item.role, characters: item.content.length, sourceCount: item.sourceIds?.length ?? 0, images: item.images?.length ?? 0 }));
  return { prefixVersion: prompt.prefixVersion, prefix: summarize(prompt.prefix), history: summarize(prompt.history), inputs: summarize(prompt.inputs) };
}
export async function saveRunRuntime(store: RecordStore, server: string, runId: string) {
  await store.putRecord(server, 'run_runtime', runId, { ...runtimeVersion(), startedAt: Date.now() }, 0);
}
