import type { Message } from "./domain.js";

export interface MemoryRecord {
  id: string;
  server: string;
  channel: string;
  author: string;
  content: string;
  sourceIds: string[];
  status: "active" | "invalidated" | "forgotten";
}

export interface Evidence {
  content: string;
  sourceIds: readonly string[];
  author: string;
  kind: "message" | "memory" | "retrieval";
  targetAuthor?: string;
  authorName?: string;
  sourceUrl?: string;
}

export interface Embeddings {
  readonly model: string;
  embed(text: string): Promise<readonly number[]>;
  embedWithUsage?(text: string): Promise<{ vector: readonly number[]; tokens: number | null }>;
}

export interface Recall {
  retrieve(message: Message, limit: number): Promise<readonly Evidence[]>;
}

export interface Knowledge {
  remember(message: Message, content: string): Promise<MemoryRecord>;
  memories(server: string, channel: string): Promise<readonly MemoryRecord[]>;
  forget(server: string, channel: string, id: string, actor: string): Promise<boolean>;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!; left += a[i]! ** 2; right += b[i]! ** 2;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

const stopWords = new Set("a an the is are was were be to of in for and or it this that what who how why do did does my me you we our please slopbot".split(" "));
export function searchTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])]
    .filter(term => term.length > 1 && !stopWords.has(term)).slice(0, 12);
}
