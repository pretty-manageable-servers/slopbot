import type { PromptItem } from "./domain.js";

export const DEFAULT_CONTEXT_TOKENS = 200000;
export const DEFAULT_OUTPUT_TOKENS = 50000;

// PMServers prompting guide, reviewed 2026-10-12.
export function modelTokenLimits(model: string, baseUrl: string): { context: number; output: number } | undefined {
  if (new URL(baseUrl).hostname !== "api.pmservers.org") return undefined;
  if (["nimbus", "qwen3.8-flash-next"].includes(model)) return { context: 200000, output: 50000 };
  if (["cirrus", "gemma4-e4b"].includes(model)) return { context: 64000, output: 32000 };
  return undefined;
}

export interface TokenCounter {
  readonly name: string;
  count(items: readonly PromptItem[]): number;
}

// Conservative UTF-8 byte estimate until a provider tokenizer is configured.
// Includes JSON author tags and message framing; it is not a billing token count.
export class ByteTokenCounter implements TokenCounter {
  readonly name = "utf8-byte-upper-estimate";
  count(items: readonly PromptItem[]): number {
    return items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), "utf8") + 32, 0);
  }
}

export interface HistoryEntry { sequence: number; item: PromptItem }
export interface TaskContext { checkpoint: PromptItem | null; entries: HistoryEntry[] }
