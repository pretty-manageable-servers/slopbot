import type { IncomingMessage, ServerResponse } from 'node:http';
import { logError } from '../../errors.js';
import type { PmAudio } from '../../adapters/audio.js';

export const TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;
const PER_MINUTE = 60;
// The kit sends a partial every 2 s and never two partials at once, but the final clip can start while a partial runs.
const AT_ONCE = 2;

/** Per-user dictation limits: two requests at a time, 60 per minute. */
export interface TranscribeLimits { busy: Map<string, number>; recent: Map<string, number[]> }
export const transcribeLimits = (): TranscribeLimits => ({ busy: new Map(), recent: new Map() });

export interface TranscribeDeps {
  /** Undefined when the bot has no audio config. */
  audio: Pick<PmAudio, 'transcribeWav'> | undefined;
  origin: string;
  limits: TranscribeLimits;
  now?: () => number;
}

export const handlesTranscribe = (method: string | undefined, path: string): boolean => method === 'POST' && path === '/api/transcribe';

const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

/** POST /api/transcribe for a signed-in user: raw audio/wav in, {text} out. */
export async function handleTranscribe(req: IncomingMessage, res: ServerResponse, session: { user: string; csrf: string }, deps: TranscribeDeps): Promise<void> {
  if (req.headers.origin !== new URL(deps.origin).origin || req.headers['x-csrf-token'] !== session.csrf) return send(res, 403, { error: 'Invalid request.' });
  if (!deps.audio) { req.resume(); return send(res, 503, { error: 'Dictation is not available.' }); }
  if (!req.headers['content-type']?.startsWith('audio/')) { req.resume(); return send(res, 415, { error: 'Send audio.' }); }
  const { limits, user } = { limits: deps.limits, user: session.user };
  const now = (deps.now ?? Date.now)();
  const recent = (limits.recent.get(user) ?? []).filter(at => now - at < 60_000);
  if ((limits.busy.get(user) ?? 0) >= AT_ONCE || recent.length >= PER_MINUTE) { req.resume(); return send(res, 429, { error: 'Too many dictation requests. Try again shortly.' }); }
  limits.busy.set(user, (limits.busy.get(user) ?? 0) + 1); limits.recent.set(user, [...recent, now]);
  try {
    if (Number(req.headers['content-length']) > TRANSCRIBE_MAX_BYTES) { req.resume(); return send(res, 413, { error: 'Audio can be 10 MB or smaller.' }); }
    const chunks: Buffer[] = []; let size = 0;
    // Past the limit nothing is kept. The rest of the body is read and dropped, so the 413 reaches the client.
    for await (const chunk of req) { size += chunk.length; if (size <= TRANSCRIBE_MAX_BYTES) chunks.push(chunk); }
    if (size > TRANSCRIBE_MAX_BYTES) return send(res, 413, { error: 'Audio can be 10 MB or smaller.' });
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    let text: string;
    try { text = await deps.audio.transcribeWav(Buffer.concat(chunks), controller.signal); } catch (error) {
      logError('web_transcribe_failed', error, { stage: 'web_transcribe' });
      return send(res, 502, { error: 'Transcription failed.' });
    }
    send(res, 200, { text });
  } finally {
    const left = (limits.busy.get(user) ?? 1) - 1;
    if (left) limits.busy.set(user, left); else limits.busy.delete(user);
  }
}
