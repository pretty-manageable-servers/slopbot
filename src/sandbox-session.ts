import { posix } from 'node:path';
import { logError } from './errors.js';
import type { Message } from './domain.js';
import type { RecordStore } from './records.js';
import { requestTimings } from './request-timing.js';
import type { SandboxProvider, SandboxSession } from './sandbox.js';

/** Home of the sandbox user when the sandbox cannot tell us. The base template uses ubuntu, so this is only a fallback. */
export const SANDBOX_HOME = '/home/user';
/** A sandbox expires this long after its last command, write or upload. */
export const SANDBOX_LIFETIME_MS = 600000;

interface SandboxRecord { id?: string; expiresAt?: number; template?: string; home?: string }

/** Wait before the second connect try after a failed connect. */
export const SANDBOX_CONNECT_RETRY_MS = 1000;
const homeSeconds = 10;
const homePattern = /^\/[A-Za-z0-9._@+/-]{1,199}$/;
/** True for a home directory path that the sandbox reports and the bot accepts. */
export function isSandboxHome(value: string): boolean { return homePattern.test(value); }

/** Resolves a path the model gave: a relative path, ~, ~/x or an absolute path. Relative paths and ~ start in home. Never fails. */
export function resolveSandboxPath(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return posix.normalize(`${home}/${path.slice(2)}`);
  if (path.startsWith('/')) return posix.normalize(path);
  return posix.normalize(`${home}/${path}`);
}

/** Reads $HOME of the sandbox user. Returns undefined when the command fails or prints no usable path. */
async function readHome(session: SandboxSession): Promise<string | undefined> {
  try {
    const output = await requestTimings.wait('sandbox home', () => session.run('printf %s "$HOME"', homeSeconds * 1000));
    const home = output.exitCode === 0 ? output.stdout.trim() : '';
    return homePattern.test(home) ? home : undefined;
  } catch { return undefined; }
}

/** Connects to a recorded sandbox. Tries twice. Returns undefined when both tries fail, so the caller can create a new one. */
async function connectWithRetry(provider: SandboxProvider, id: string): Promise<SandboxSession | undefined> {
  try { return await requestTimings.wait('sandbox connect', () => provider.connect(id)); }
  catch { await new Promise(resolve => setTimeout(resolve, SANDBOX_CONNECT_RETRY_MS)); }
  try { return await requestTimings.wait('sandbox connect', () => provider.connect(id)); }
  catch { return undefined; }
}

/** Returns the session of this channel or thread. Creates one when none is active, and renews the lease. A recorded sandbox that cannot be connected is replaced: the result then has created true. Never fails on a lost record race: it reads the record again. home is the home directory of the sandbox user; it is read once per sandbox and falls back to SANDBOX_HOME. */
export async function sandboxSession(store: RecordStore, provider: SandboxProvider, message: Message, operationId: string): Promise<{ session: SandboxSession; created: boolean; template?: string; home: string }> {
  for (let attempt = 0; ; attempt++) {
    const record = await store.record(message.server, 'sandbox', message.channel);
    const value = record?.value as SandboxRecord | undefined;
    const active = value?.id && (value.expiresAt ?? 0) > Date.now() ? value.id : undefined;
    const template = active ? value?.template : provider.defaultTemplate ?? 'base';
    let session: SandboxSession | undefined, created = false;
    if (active) session = await connectWithRetry(provider, active);
    if (!session) { session = await requestTimings.wait('sandbox create', () => provider.create({ server: message.server, channel: message.channel, operation: operationId }, SANDBOX_LIFETIME_MS, template)); created = true; }
    if (!created) await requestTimings.wait('sandbox lease', () => session.renew(SANDBOX_LIFETIME_MS));
    // A reconnected sandbox keeps its recorded home. A new sandbox, or a record without one, reads $HOME. A failed read is not saved, so the next call tries again.
    const found = !created && value?.home ? value.home : await readHome(session);
    const saved = await store.putRecord(message.server, 'sandbox', message.channel, { id: session.id, expiresAt: Date.now() + SANDBOX_LIFETIME_MS, ...(template ? { template } : {}), ...(found ? { home: found } : {}) }, record?.revision ?? 0);
    if (saved) return { session, created, ...(template ? { template } : {}), home: found ?? SANDBOX_HOME };
    if (created) await session.close().catch(error => logError('sandbox_create_cleanup_failed', error, { stage: 'sandbox cleanup', operationId }, true));
    if (attempt >= 2) throw new Error('Sandbox record kept changing.');
  }
}
