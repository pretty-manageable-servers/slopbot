import type { PromptItem } from "./domain.js";

export const DEFAULT_CONTEXT_TOKENS = 131072;
export const DEFAULT_OUTPUT_TOKENS = 65536;

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
