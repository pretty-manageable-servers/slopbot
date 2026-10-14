import { logError } from './errors.js';
import type { Attachment, Message } from './domain.js';
import type { FileFetcher } from './files.js';
import type { RecordStore } from './records.js';
import { requestTimings } from './request-timing.js';
import { SANDBOX_UPLOAD_DIR, sandboxSession } from './sandbox-session.js';
import type { SandboxProvider } from './sandbox.js';

export interface UploadDeps {
  store: RecordStore;
  provider: SandboxProvider;
  /** Downloads the bytes. Enforces the 10 MiB limit. */
  fetcher: FileFetcher;
}

const IMAGE = /^image\//i;
const UPLOAD_MKDIR_SECONDS = 30;

/** Keeps the last part of a name, drops control characters and characters that are unsafe in a path. */
export function uploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\x00-\x1f\x7f]/g, '').replace(/[^\w.@ +()-]/g, '_').replace(/^\.+/, '').trim();
  return (clean || 'file').slice(0, 120);
}

/** Adds -1, -2 before the extension when a name is already used by an earlier file of the same message. */
export function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map(name => {
    const dot = name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length;
    const stem = name.slice(0, dot), ext = name.slice(dot);
    let candidate = name;
    for (let n = 1; used.has(candidate); n++) candidate = `${stem}-${n}${ext}`;
    used.add(candidate);
    return candidate;
  });
}

/** True for the files that go to the sandbox. Images keep the inline vision path. Link previews are not files. */
export function isUploadable(attachment: Attachment): boolean {
  return !attachment.preview && !IMAGE.test(attachment.contentType ?? '');
}

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Writes the non-image files of a request to SANDBOX_UPLOAD_DIR before the model run.
 * Returns undefined when the message has no such files. A failure is logged and reported as a failed name; it never throws.
 */
export async function uploadRequestFiles(deps: UploadDeps, message: Message): Promise<{ files: string[]; failed: string[] } | undefined> {
  const attachments = (message.attachments ?? []).filter(isUploadable);
  if (!attachments.length) return undefined;
  const names = uniqueNames(attachments.map(item => uploadName(item.name)));
  const files: string[] = [], failed: string[] = [];
  let session: Awaited<ReturnType<typeof sandboxSession>>['session'];
  try {
    session = (await sandboxSession(deps.store, deps.provider, message, `upload:${message.id}`)).session;
    const made = await requestTimings.wait('sandbox upload directory', () => session.run(`mkdir -p ${SANDBOX_UPLOAD_DIR}`, UPLOAD_MKDIR_SECONDS * 1000));
    if (made.exitCode !== 0) throw new Error(`mkdir failed: ${made.stderr.trim() || made.exitCode}`);
  } catch (error) {
    logError('sandbox_upload_failed', error, { stage: 'sandbox upload', server: message.server, channel: message.channel, messageId: message.id }, true);
    return { files: [], failed: names.map(name => `${name}: ${reason(error)}`) };
  }
  for (let index = 0; index < attachments.length; index++) {
    const path = `${SANDBOX_UPLOAD_DIR}/${names[index]!}`;
    try {
      const bytes = await requestTimings.wait('file upload download', () => deps.fetcher.fetch(attachments[index]!));
      await requestTimings.wait('sandbox upload write', () => session.write(path, bytes));
      files.push(path);
    } catch (error) {
      logError('sandbox_upload_failed', error, { stage: 'sandbox upload', server: message.server, channel: message.channel, messageId: message.id }, true);
      failed.push(`${names[index]!}: ${reason(error)}`);
    }
  }
  return { files, failed };
}
