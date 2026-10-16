import { createHash, randomUUID } from 'node:crypto';
import type { Json, Message } from "./domain.js";
import { ToolError } from './errors.js';
import type { Attribution } from "./usage-meter.js";

export interface MemoryRecord {
  id: string;
  server: string;
  channel: string;
  author: string;
  content: string;
  sourceIds: string[];
  status: "active" | "invalidated" | "forgotten";
  category: MemoryCategory;
  tags: string[];
  details: Record<string, Json>;
  sourcePolicy: SourcePolicy;
  revision: number;
  updatedAt: number;
  lastOperationId?: string;
}

export const MEMORY_CATEGORIES = ['fact', 'meme', 'preference', 'lesson', 'note'] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];
export type SourcePolicy = 'source_bound' | 'independent';
export interface MemoryOptions {
  category?: MemoryCategory;
  tags?: string[];
  details?: Record<string, Json>;
  sourcePolicy?: SourcePolicy;
  sourceIds?: string[];
  operationId?: string;
}
export interface MemoryPatch { content?: string; category?: MemoryCategory; tags?: string[]; details?: Record<string, Json> }
export interface MemoryQuery { query?: string; category?: MemoryCategory; tags?: string[]; limit?: number; offset?: number; relatedOnly?: boolean }
export function memoryIdForOperation(operation: string): string { return `memory-${createHash('sha256').update(operation).digest('hex').slice(0, 32)}`; }
export function validateMemory(content: string, category: MemoryCategory, tags: string[], details: Record<string, Json>): void {
  if (typeof content !== 'string' || !content.trim() || content.length > 2000) throw new ToolError('Memory must contain 1–2000 characters.');
  if (!MEMORY_CATEGORIES.includes(category)) throw new ToolError('Unknown memory category.');
  if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 80)) throw new ToolError('Use up to 20 nonempty tags, each at most 80 characters.');
  if (!details || typeof details !== 'object' || Array.isArray(details) || JSON.stringify(details).length > 8000) throw new ToolError('Memory details must be an object of at most 8000 characters.');
  const allowed = category === 'meme' ? ['media_url', 'media_type', 'aliases', 'when_to_use', 'humor_notes', 'interpretation'] : category === 'lesson' ? ['subject', 'when_to_use'] : ['subject'];
  for (const [key, value] of Object.entries(details)) {
    if (!allowed.includes(key)) throw new ToolError(`Unsupported ${category} detail: ${key}.`);
    if (key === 'aliases') {
      if (!Array.isArray(value) || value.length > 20 || value.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 200)) throw new ToolError('Use up to 20 nonempty aliases of at most 200 characters.');
    } else if (typeof value !== 'string' || value.length > 2000) throw new ToolError(`Detail ${key} must be text of at most 2000 characters.`);
    if (key === 'media_type' && !['image', 'gif', 'video'].includes(String(value))) throw new ToolError('media_type must be image, gif, or video.');
    if (key === 'media_url') {
      let url: URL; try { url = new URL(String(value)); } catch { throw new ToolError('media_url must be a public HTTPS URL.'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new ToolError('media_url must be a public HTTPS URL.');
    }
  }
}
export function newMemory(message: Message, content: string, options: MemoryOptions = {}): MemoryRecord {
  const category = options.category ?? 'fact', tags = options.tags ?? [], details = options.details ?? {};
  validateMemory(content, category, tags, details);
  const sourcePolicy = options.sourcePolicy ?? (category === 'meme' ? 'independent' : 'source_bound');
  if (!['source_bound', 'independent'].includes(sourcePolicy)) throw new ToolError('Unknown memory source policy.');
  const sourceIds = options.sourceIds ?? (sourcePolicy === 'source_bound' ? [message.id] : []);
  if (!Array.isArray(sourceIds) || sourceIds.length > 20 || sourceIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 160)) throw new ToolError('Use up to 20 valid source message IDs.');
  if (sourcePolicy === 'source_bound' && !sourceIds.length) throw new ToolError('Source-bound memory requires a source.');
  if (sourcePolicy === 'independent' && sourceIds.length) throw new ToolError('Independent memory does not retain source message IDs.');
  return { id: options.operationId ? memoryIdForOperation(options.operationId) : randomUUID(), server: message.server, channel: message.channel, author: message.author, content: content.trim(), category, tags: [...new Set(tags.map(tag => tag.trim()))], details, sourcePolicy, sourceIds: [...new Set(sourceIds)], status: 'active', revision: 1, updatedAt: Date.now(), ...(options.operationId ? { lastOperationId: options.operationId } : {}) };
}
export function patchMemory(memory: MemoryRecord, patch: MemoryPatch, operationId?: string): MemoryRecord {
  const next = { ...memory, ...patch, revision: memory.revision + 1, updatedAt: Date.now(), ...(operationId ? { lastOperationId: operationId } : {}) };
  validateMemory(next.content, next.category, next.tags, next.details);
  next.content = next.content.trim(); next.tags = [...new Set(next.tags.map(tag => tag.trim()))];
  return next;
}
export function memoryMetadata(memory: MemoryRecord): string {
  return JSON.stringify({ category: memory.category, tags: memory.tags, details: memory.details, sourcePolicy: memory.sourcePolicy, revision: memory.revision, updatedAt: memory.updatedAt, ...(memory.lastOperationId ? { lastOperationId: memory.lastOperationId } : {}) });
}
export function memoryFromRow(row: Record<string, unknown>, sourceIds: string[] = []): MemoryRecord {
  const meta = JSON.parse(String(row.metadata ?? '{}')) as Partial<MemoryRecord>;
  return { id: String(row.id), server: String(row.server), channel: String(row.channel), author: String(row.author), content: String(row.content), status: row.status as MemoryRecord['status'], category: meta.category ?? 'fact', tags: meta.tags ?? [], details: meta.details ?? {}, sourcePolicy: meta.sourcePolicy ?? 'source_bound', revision: meta.revision ?? 1, updatedAt: meta.updatedAt ?? Number(row.created_at), sourceIds, ...(meta.lastOperationId ? { lastOperationId: meta.lastOperationId } : {}) };
}
export function memorySearchText(memory: MemoryRecord): string {
  return [memory.content, ...(memory.category === 'fact' ? [] : [memory.category]), ...memory.tags, ...(Object.keys(memory.details).length ? [JSON.stringify(memory.details)] : [])].join('\n');
}
export function rankMemories(memories: readonly MemoryRecord[], query: MemoryQuery, semanticScores: ReadonlyMap<string, number> = new Map()): MemoryRecord[] {
  const terms = searchTerms(query.query ?? '');
  return memories.filter(memory => (!query.category || memory.category === query.category) && (!query.tags?.length || query.tags.every(tag => memory.tags.includes(tag))))
    .map(memory => ({ memory, score: terms.filter(term => memorySearchText(memory).toLowerCase().includes(term)).length + Math.max(0, semanticScores.get(memory.id) ?? 0) }))
    .filter(item => query.relatedOnly === false || !query.query?.trim() || item.score > 0)
    .sort((a, b) => b.score - a.score).slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 20)).map(item => item.memory);
}

export interface Evidence {
  content: string;
  sourceIds: readonly string[];
  author: string;
  kind: "message" | "memory" | "retrieval";
  targetAuthor?: string;
  authorName?: string;
  sourceUrl?: string;
  memoryId?: string;
  category?: MemoryCategory;
  tags?: string[];
  details?: Record<string, Json>;
}

export interface Embeddings {
  readonly model: string;
  embed(text: string): Promise<readonly number[]>;
  // who pays for the call; undefined when no user can be charged
  embedWithUsage?(text: string, who?: Attribution): Promise<{ vector: readonly number[]; tokens: number | null }>;
}

export interface Recall {
  retrieve(message: Message, limit: number): Promise<readonly Evidence[]>;
}

export interface Knowledge {
  remember(message: Message, content: string, options?: MemoryOptions): Promise<MemoryRecord>;
  memories(server: string, channel: string): Promise<readonly MemoryRecord[]>;
  searchMemories(message: Message, query?: MemoryQuery): Promise<readonly MemoryRecord[]>;
  updateMemory(message: Message, id: string, patch: MemoryPatch, expectedRevision: number, operationId?: string): Promise<MemoryRecord | undefined>;
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
