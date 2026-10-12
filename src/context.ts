import { promptItems, type Prompt, type PromptItem } from "./domain.js";
import { RequestError } from "./errors.js";

export const DEFAULT_CONTEXT_TOKENS = 200000;
export const DEFAULT_OUTPUT_TOKENS = 50000;

// PMServers prompting guide, reviewed 2026-10-12.
export function modelTokenLimits(model: string, baseUrl: string): { context: number; output: number } | undefined {
  if (new URL(baseUrl).hostname !== "api.pmservers.org") return undefined;
  if (["nimbus", "qwen3.8-flash-next"].includes(model)) return { context: 200000, output: 50000 };
  if (["cirrus", "gemma4-e4b"].includes(model)) return { context: 64000, output: 32000 };
  return undefined;
}

export function withInspectionBudget(limits: { outputTokenLimit?: number; contextTokenLimit?: number }, prompt: Prompt): Prompt {
  const output = limits.outputTokenLimit ?? DEFAULT_OUTPUT_TOKENS;
  const context = limits.contextTokenLimit ?? DEFAULT_CONTEXT_TOKENS;
  const counter = new ByteTokenCounter();
  const input = counter.count(promptItems(prompt)) + (prompt.tools ? counter.count([{ role: 'system', content: JSON.stringify(prompt.tools) }]) : 0);
  const available = context - input;
  if (available < 128) throw new RequestError('CONTEXT_BUDGET', `Inspection input uses ${input} estimated units of a ${context} context budget, leaving ${available} for output.`, 'Narrow the input or increase the context allowance within the model limit.', { input, context, available, purpose: 'inspection' });
  return { ...prompt, purpose: 'inspection', maxOutputTokens: Math.min(output, available) };
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
