import { logError } from './errors.js';
import type { Message } from './domain.js';
import type { RecordStore } from './records.js';
import { requestTimings } from './request-timing.js';
import type { SandboxProvider, SandboxSession } from './sandbox.js';

export const SANDBOX_HOME = '/home/user';
export const SANDBOX_UPLOAD_DIR = '/home/user/uploads';
/** A sandbox expires this long after its last command, write or upload. */
export const SANDBOX_LIFETIME_MS = 600000;

interface SandboxRecord { id?: string; expiresAt?: number; template?: string }

/** Wait before the second connect try after a failed connect. */
export const SANDBOX_CONNECT_RETRY_MS = 1000;

/** Connects to a recorded sandbox. Tries twice. Returns undefined when both tries fail, so the caller can create a new one. */
async function connectWithRetry(provider: SandboxProvider, id: string): Promise<SandboxSession | undefined> {
  try { return await requestTimings.wait('sandbox connect', () => provider.connect(id)); }
  catch { await new Promise(resolve => setTimeout(resolve, SANDBOX_CONNECT_RETRY_MS)); }
  try { return await requestTimings.wait('sandbox connect', () => provider.connect(id)); }
  catch { return undefined; }
}

/** Returns the session of this channel or thread. Creates one when none is active, and renews the lease. A recorded sandbox that cannot be connected is replaced: the result then has created true. Never fails on a lost record race: it reads the record again. */
export async function sandboxSession(store: RecordStore, provider: SandboxProvider, message: Message, operationId: string): Promise<{ session: SandboxSession; created: boolean; template?: string }> {
  for (let attempt = 0; ; attempt++) {
    const record = await store.record(message.server, 'sandbox', message.channel);
    const value = record?.value as SandboxRecord | undefined;
    const active = value?.id && (value.expiresAt ?? 0) > Date.now() ? value.id : undefined;
    const template = active ? value?.template : provider.defaultTemplate ?? 'base';
    let session: SandboxSession | undefined, created = false;
    if (active) session = await connectWithRetry(provider, active);
    if (!session) { session = await requestTimings.wait('sandbox create', () => provider.create({ server: message.server, channel: message.channel, operation: operationId }, SANDBOX_LIFETIME_MS, template)); created = true; }
    if (!created) await requestTimings.wait('sandbox lease', () => session.renew(SANDBOX_LIFETIME_MS));
    const saved = await store.putRecord(message.server, 'sandbox', message.channel, { id: session.id, expiresAt: Date.now() + SANDBOX_LIFETIME_MS, ...(template ? { template } : {}) }, record?.revision ?? 0);
    if (saved) return { session, created, ...(template ? { template } : {}) };
    if (created) await session.close().catch(error => logError('sandbox_create_cleanup_failed', error, { stage: 'sandbox cleanup', operationId }, true));
    if (attempt >= 2) throw new Error('Sandbox record kept changing.');
  }
}
