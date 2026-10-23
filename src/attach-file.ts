import { randomUUID } from "node:crypto";
import { logError } from "./errors.js";
import type { Message } from "./domain.js";
import type { RecordStore } from "./records.js";
import { readSandboxFile, type SandboxProvider } from "./sandbox.js";
import type { SandboxProfile } from "./sandbox-profile.js";
import { matchName, sniffMedia } from "./media-sniff.js";
import { storagePath, type ObjectStorageProvider, type StorageScope, type UserFileStorage } from "./object-storage.js";
import { ToolError, type ToolDefinition, type ToolRegistry } from "./tools.js";

/** Up to this size the file is attached to the Discord reply. */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
/** Up to this size the file goes to object storage and the reply gets a link. Larger files are refused. */
export const LINK_MAX_BYTES = 100 * 1024 * 1024;
/** Lifetime of a link. The object is deleted after it. */
export const LINK_SECONDS = 7 * 24 * 60 * 60;
const QUEUE_TTL_MS = 60 * 60 * 1000;
const LINK_KIND = "attach_link";

export interface QueuedFile { name: string; contentType: string; bytes: Uint8Array; description?: string }
export interface QueuedLink { name: string; url: string; description?: string }
export interface RunAttachments { files: QueuedFile[]; links: QueuedLink[] }

/**
 * Files that attach_file queued for each run, keyed by the request message. The reply of the run takes them.
 * The queue is in memory: a restart drops files that were queued but not yet replied.
 */
export class AttachQueue {
  private readonly runs = new Map<string, { at: number; files: QueuedFile[]; links: QueuedLink[] }>();
  private entry(run: string): { at: number; files: QueuedFile[]; links: QueuedLink[] } {
    const now = Date.now();
    for (const [key, value] of this.runs) if (now - value.at > QUEUE_TTL_MS) this.runs.delete(key);
    const found = this.runs.get(run) ?? { at: now, files: [], links: [] };
    found.at = now; this.runs.set(run, found);
    return found;
  }
  addFile(run: string, file: QueuedFile): void { this.entry(run).files.push(file); }
  addLink(run: string, link: QueuedLink): void { this.entry(run).links.push(link); }
  /** Returns and clears what the run queued. */
  take(run: string): RunAttachments {
    const found = this.runs.get(run);
    this.runs.delete(run);
    return { files: found?.files ?? [], links: found?.links ?? [] };
  }
}

/** Files in batches of at most `size` for Discord messages (10 per message). */
export function fileBatches<T>(files: readonly T[], size = 10): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < files.length; at += size) batches.push(files.slice(at, at + size));
  return batches;
}

/** The queue key of one run: the server and the request message ID. */
export const runKey = (server: string, messageId: string) => `${server}:${messageId}`;

/** A file name with no path or control characters, at most 100 characters. */
export function attachName(raw: string): string {
  const base = raw.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
  return base || "file";
}

/** Deletes the objects of links that have expired. Returns the count. Runs on a timer and never throws. */
export async function sweepAttachLinks(store: RecordStore, provider: ObjectStorageProvider | undefined, server: string, now = Date.now()): Promise<number> {
  if (!provider) return 0;
  let deleted = 0;
  for (const record of await store.records(server, LINK_KIND)) {
    const value = record.value as { key?: string; deleteAt?: number; deleted?: boolean };
    if (value.deleted || !value.key || (value.deleteAt ?? 0) > now) continue;
    try {
      await provider.delete(value.key);
      await store.putRecord(server, LINK_KIND, record.id, { ...value, deleted: true }, record.revision);
      deleted++;
    } catch (error) { logError("attach_link_sweep_failed", error, { server }, true); }
  }
  return deleted;
}

/** Sweeps expired links every hour. Returns the stop function. */
export function startAttachLinkSweep(store: RecordStore, provider: ObjectStorageProvider | undefined, server: string): () => void {
  const timer = setInterval(() => { void sweepAttachLinks(store, provider, server).catch(error => logError("attach_link_sweep_failed", error, { server }, true)); }, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

export interface AttachDeps {
  store: RecordStore;
  queue: AttachQueue;
  storage: UserFileStorage;
  /** Object storage for links. Without it, files over 10 MB are refused. */
  provider?: ObjectStorageProvider;
  /** The sandbox of the task. Without it, sandbox paths are refused. */
  sandbox?: { provider: SandboxProvider; profile?: SandboxProfile };
  authorize(message: Message): Promise<void>;
}

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/** attach_file: queues a sandbox file or a file_store file for the reply of this run. No URLs. */
export function registerAttachFile(registry: ToolRegistry, deps: AttachDeps): void {
  const tool: ToolDefinition = {
    name: "attach_file", surface: "top", access: "member", effect: "read", retrySafe: true,
    description: "Attach a file to your reply: a sandbox file (path) or a file_store file (store:<scope>/<path>, scope user, server or user_server). Media is shown inline. Files over 10 MB become a 7-day link in the reply. Files over 100 MB are refused.",
    fields: {
      path: { type: "string", required: true, description: "Sandbox path, or store:<scope>/<path> for a file_store file." },
      name: { type: "string", description: "File name to show. Default: the file's own name." },
      description: { type: "string", description: "One short line shown with the file." },
    },
    execute: async (context, args) => {
      await deps.authorize(context.message);
      const path = String(args.path), server = context.message.server, requester = context.message.author;
      let bytes: Uint8Array, defaultName: string;
      const stored = /^store:(user|server|user_server)\/(.+)$/.exec(path);
      if (path.startsWith("store:")) {
        if (!stored) throw new ToolError("Use store:<scope>/<path>, where scope is user, server or user_server.");
        const scope = stored[1] as StorageScope, owner = scope === "server" ? server : requester;
        const read = await deps.storage.read(server, requester, owner, storagePath(stored[2]), scope, context.isAdmin);
        bytes = read.bytes; defaultName = read.file.path.split("/").at(-1)!;
      } else {
        if (!deps.sandbox) throw new ToolError("Sandbox is not configured.");
        bytes = await readSandboxFile(deps.store, deps.sandbox.provider, context, path, LINK_MAX_BYTES + 1, deps.sandbox.profile?.home);
        defaultName = path.split("/").at(-1) || "file";
      }
      if (bytes.length > LINK_MAX_BYTES) throw new ToolError(`That file is ${mb(bytes.length)}. Files over 100 MB cannot be attached.`);
      const media = sniffMedia(bytes);
      const name = matchName(attachName(args.name ? String(args.name) : defaultName), media);
      const contentType = media?.contentType ?? "application/octet-stream";
      const description = args.description ? String(args.description).slice(0, 200) : undefined;
      const run = runKey(server, context.message.id);
      if (bytes.length <= ATTACH_MAX_BYTES) {
        deps.queue.addFile(run, { name, contentType, bytes, ...(description ? { description } : {}) });
        return { text: `Attached ${name} (${mb(bytes.length)}) to the reply.` };
      }
      const provider = deps.provider;
      if (!provider) throw new ToolError("This file is over 10 MB and object storage is not configured.");
      const key = `attachments/${encodeURIComponent(server)}/${randomUUID()}/${name}`;
      await provider.put(key, bytes, contentType);
      try {
        const url = await provider.link(key, name, LINK_SECONDS, true);
        await deps.store.putRecord(server, LINK_KIND, randomUUID(), { key, deleteAt: Date.now() + LINK_SECONDS * 1000 }, 0);
        deps.queue.addLink(run, { name, url, ...(description ? { description } : {}) });
      } catch (error) {
        await provider.delete(key).catch(cleanup => logError("attach_link_cleanup_failed", cleanup, { server }, true));
        throw error;
      }
      return { text: `${name} (${mb(bytes.length)}) is linked in the reply. The link works for 7 days.` };
    },
  };
  registry.register(tool);
}
