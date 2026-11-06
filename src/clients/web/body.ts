import { z } from 'zod';
import { json, type WebContext } from './env.js';

/** The ID of a Discord server, channel or user. */
export const SNOWFLAKE = /^\d{17,20}$/;
export const snowflakeField = (message: string) => z.string({ error: message }).regex(SNOWFLAKE, message);

/** Reads the request body as bytes. Past `limit` nothing more is kept: `drain` reads the rest and drops it, otherwise reading stops. */
export async function readBytes(c: WebContext, limit: number, drain = false): Promise<Buffer | 'too-large'> {
  const stream = c.req.raw.body;
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { over = true; if (!drain) break; continue; }
    chunks.push(value);
  }
  reader.releaseLock();
  return over ? 'too-large' : Buffer.concat(chunks);
}

/** Rejects a body whose Content-Length is already over the limit, before any byte is read. */
export const declaredTooLarge = (c: WebContext, limit: number) => Number(c.req.header('content-length')) > limit;

/**
 * The JSON body of a write: 415 without a JSON content type, 413 past `limit` bytes, 400 for invalid JSON.
 * The bytes are decoded once, so a character split between two chunks stays whole. An empty body is `{}` when `emptyIsObject` is set.
 */
export async function readJson(c: WebContext, limit: number, emptyIsObject = false): Promise<{ value: unknown } | { error: Response }> {
  if (!c.req.header('content-type')?.startsWith('application/json')) return { error: json(415, { error: 'Send JSON.' }) };
  const bytes = await readBytes(c, limit);
  if (bytes === 'too-large') return { error: json(413, { error: 'Request too large.' }) };
  const text = bytes.toString('utf8');
  if (emptyIsObject && !text) return { value: {} };
  try { return { value: JSON.parse(text) }; } catch { return { error: json(400, { error: 'Invalid JSON.' }) }; }
}

/** Checks a value with a schema. The first issue's message is the 400 answer. */
export function check<T extends z.ZodType>(schema: T, value: unknown): { value: z.infer<T> } | { error: Response } {
  const result = schema.safeParse(value);
  return result.success ? { value: result.data } : { error: json(400, { error: result.error.issues[0]?.message ?? 'Invalid request.' }) };
}

/** An object body. Anything that is not an object counts as an empty one. */
export const looseBody = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const serverOnly = z.looseObject({ server: snowflakeField('Invalid server.').optional() });
/** The JSON body of a settings-style write: `readJson`, then the optional `server` every such body may carry must be an ID. */
export async function readInput(c: WebContext, limit: number): Promise<{ value: unknown } | { error: Response }> {
  const body = await readJson(c, limit);
  if ('error' in body) return body;
  const server = check(serverOnly, looseBody(body.value));
  return 'error' in server ? server : body;
}
