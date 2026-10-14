import { logError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type { Json, Message } from './domain.js';
import type { RecordStore, AppRecord } from './records.js';
import { ToolError, discordOnlyMessage, type ToolContext, type ToolDefinition } from './tools.js';
import { isPrivateChannel } from './private-chat.js';
import { DiscordFileFetcher, type FileFetcher } from './files.js';
import { sourceFingerprint } from './source-context.js';
import { sandboxSession } from './sandbox-session.js';
import type { SandboxProvider } from './sandbox.js';

export const MAX_STORED_FILE_BYTES = 10 * 1024 * 1024;
export interface ObjectStorageProvider {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** maxBytes defaults to MAX_STORED_FILE_BYTES. */
  get(key: string, maxBytes?: number): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  link(key: string, name: string, seconds: number): Promise<string>;
}
export type StorageScope = 'user' | 'server' | 'user_server';
export const storageScopes: readonly StorageScope[] = ['user', 'server', 'user_server'];
export function fileStorageScope(file: StoredFile): StorageScope { return file.storageScope ?? 'user_server'; }
export interface StoredFile {
  storageScope?: StorageScope; server?: string; createdBy?: string;
  owner: string; path: string; key: string; size: number; contentType: string;
  public: boolean; updatedAt: number; deleted?: boolean;
}
const kind = 'stored_file';
const globalFiles = '__slopbot_global_files__';
function location(server: string, owner: string, path: string, scope: StorageScope) {
  return { server: scope === 'user' ? globalFiles : server, kind: scope === 'server' ? 'stored_server_file' : kind, id: id(scope === 'server' ? server : owner, path) };
}
function canChange(file: StoredFile, requester: string, scope: StorageScope, isAdmin: boolean): boolean {
  return scope === 'server' ? file.createdBy === requester || isAdmin : file.owner === requester;
}
const id = (owner: string, path: string) => JSON.stringify([owner, path]);
export function storagePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 300 || /[\\\u0000-\u001f\u007f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new ToolError('Use a relative storage path such as reports/result.csv, without empty, . or .. segments.');
  return value;
}
export class UserFileStorage {
  constructor(private readonly store: RecordStore, private readonly provider?: ObjectStorageProvider) {}
  private configured(): ObjectStorageProvider {
    if (!this.provider) throw new ToolError('Object storage is not configured. Set OBJECT_STORAGE_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
    return this.provider;
  }
  async entry(server: string, requester: string, owner: string, path: string, write = false, scope: StorageScope = 'user_server', isAdmin = false): Promise<{ record: AppRecord; file: StoredFile }> {
    this.configured();
    const loc = location(server, owner, storagePath(path), scope);
    const record = await this.store.record(loc.server, loc.kind, loc.id);
    const file = record?.value as unknown as StoredFile | undefined;
    if (write && scope !== 'server' && owner !== requester) throw new ToolError('You can only change files in your own directory.');
    if (!record || !file || file.deleted || (!file.public && !canChange(file, requester, scope, isAdmin))) throw new ToolError('Stored file not found or not shared with you.');
    if (write && !canChange(file, requester, scope, isAdmin)) throw new ToolError('Only the file creator or a server admin can change this server file.');
    return { record, file: { ...file, storageScope: scope, ...(scope !== 'user' ? { server } : {}), createdBy: file.createdBy ?? file.owner } };
  }
  async list(server: string, requester: string, view: string, prefix: string, owner?: string, scope: StorageScope = 'user_server', isAdmin = false): Promise<StoredFile[]> {
    this.configured();
    const loc = location(server, requester, '', scope);
    const entries = await this.store.records(loc.server, loc.kind);
    return entries.map(record => { const file = record.value as unknown as StoredFile; return { ...file, storageScope: scope, ...(scope !== 'user' ? { server } : {}), createdBy: file.createdBy ?? file.owner }; }).filter(file => !file.deleted && (view === 'public' ? file.public : scope === 'server' ? file.public || canChange(file, requester, scope, isAdmin) : file.owner === requester) && (!owner || scope === 'server' || file.owner === owner) && file.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path) || a.owner.localeCompare(b.owner));
  }
  async save(context: ToolContext, path: string, bytes: Uint8Array, contentType: string, overwrite = false, scope: StorageScope = 'user_server'): Promise<StoredFile> {
    const provider = this.configured();
    path = storagePath(path);
    if (bytes.length > MAX_STORED_FILE_BYTES) throw new ToolError('Stored files are limited to 10 MiB.');
    if (!/^[\w.+-]+\/[\w.+-]+(?:;[\x20-\x7e]+)?$/.test(contentType)) throw new ToolError('Provide a valid MIME content_type.');
    const requester = context.message.author, server = context.message.server, owner = scope === 'server' ? server : requester;
    const loc = location(server, owner, path, scope);
    const previous = await this.store.record(loc.server, loc.kind, loc.id);
    const priorFile = previous?.value as unknown as StoredFile | undefined;
    if (priorFile && scope === 'server' && !priorFile.public && !canChange(priorFile, requester, scope, context.isAdmin)) throw new ToolError('Stored file not found or not shared with you.');
    if (priorFile && !canChange(priorFile, requester, scope, context.isAdmin)) throw new ToolError(scope === 'server' ? 'Only the file creator or a server admin can replace this server path.' : 'Only the file owner can replace this path.');
    if (priorFile && !priorFile.deleted && !overwrite) throw new ToolError('That path already exists. Use another path or explicitly set overwrite:true.');
    // Immutable blobs keep concurrent saves and old download URLs from exposing a replacement.
    const prefix = scope === 'user' ? `users/${encodeURIComponent(owner)}` : scope === 'server' ? `servers/${encodeURIComponent(server)}/shared` : `servers/${encodeURIComponent(server)}/users/${encodeURIComponent(owner)}`;
    const key = `${prefix}/${randomUUID()}/${path}`;
    const file: StoredFile = { owner, path, key, size: bytes.length, contentType, public: scope === 'server', updatedAt: Date.now(), storageScope: scope, ...(scope !== 'user' ? { server } : {}), createdBy: priorFile?.createdBy ?? requester };
    await context.assertActive();
    await provider.put(key, bytes, contentType);
    try {
      await context.assertActive();
      if (!await this.store.putRecord(loc.server, loc.kind, loc.id, file as unknown as Json, previous?.revision ?? 0)) throw new ToolError('Stored file changed concurrently. Reload its metadata before trying again.');
    } catch (error) {
      await provider.delete(key).catch(cleanup => logError('storage_uncommitted_blob_cleanup_failed', cleanup, { operationId: context.operationId, server, tool: 'file_store' }, true));
      throw error;
    }
    // A committed replacement stays committed if removal of the superseded blob fails.
    if (priorFile && !priorFile.deleted) await provider.delete(priorFile.key).catch(error => logError('storage_superseded_blob_cleanup_failed', error, { operationId: context.operationId, server, tool: 'file_store' }, true));
    return file;
  }
  async read(server: string, requester: string, owner: string, path: string, scope: StorageScope = 'user_server', isAdmin = false): Promise<{ file: StoredFile; bytes: Uint8Array }> {
    const { file } = await this.entry(server, requester, owner, path, false, scope, isAdmin);
    const bytes = await this.configured().get(file.key);
    if (bytes.length > MAX_STORED_FILE_BYTES) throw new ToolError('Stored files are limited to 10 MiB.');
    const current = await this.entry(server, requester, owner, path, false, scope, isAdmin);
    if (current.file.key !== file.key) throw new ToolError('Stored file changed while downloading. Read its current version.');
    return { file, bytes };
  }
  async share(server: string, requester: string, path: string, visible: boolean, scope: StorageScope = 'user_server', isAdmin = false): Promise<StoredFile> {
    const { record, file } = await this.entry(server, requester, requester, path, true, scope, isAdmin);
    const loc = location(server, requester, path, scope);
    const updated = { ...file, public: visible };
    if (!await this.store.putRecord(loc.server, loc.kind, loc.id, updated as unknown as Json, record.revision)) throw new ToolError('Stored file changed concurrently. Reload its metadata.');
    return updated;
  }
  async remove(server: string, requester: string, path: string, scope: StorageScope = 'user_server', isAdmin = false): Promise<void> {
    this.configured();
    const loc = location(server, requester, storagePath(path), scope);
    const record = await this.store.record(loc.server, loc.kind, loc.id);
    if (!record) throw new ToolError('Stored file not found or not shared with you.');
    const file = record.value as unknown as StoredFile;
    if (!file.public && !canChange(file, requester, scope, isAdmin)) throw new ToolError('Stored file not found or not shared with you.');
    if (!canChange(file, requester, scope, isAdmin)) throw new ToolError('Only the file creator or a server admin can delete this server file.');
    // Revoke bot access before deleting bytes. An unconfirmed delete remains journaled.
    if (!await this.store.putRecord(loc.server, loc.kind, loc.id, { ...file, deleted: true, public: false } as unknown as Json, record.revision)) throw new ToolError('Stored file changed concurrently. Reload its metadata.');
    await this.configured().delete(file.key);
  }
  async link(server: string, requester: string, owner: string, path: string, seconds: number, scope: StorageScope = 'user_server', isAdmin = false): Promise<string> {
    const { file } = await this.entry(server, requester, owner, path, false, scope, isAdmin);
    const url = await this.configured().link(file.key, file.path.split('/').at(-1)!, seconds);
    const current = await this.entry(server, requester, owner, path, false, scope, isAdmin);
    if (current.file.key !== file.key) throw new ToolError('Stored file changed while signing its download link.');
    return url;
  }
}
const metadata = (file: StoredFile) => ({ storage_scope: fileStorageScope(file), server: file.server ?? null, creator: file.createdBy ?? file.owner, owner: file.owner, path: file.path, size: file.size, content_type: file.contentType, public: file.public, updated_at: new Date(file.updatedAt).toISOString() });
export interface StorageServices {
  storage: UserFileStorage;
  authorize(message: Message): Promise<void>;
  resolveAttachment(message: Message, id: string | undefined): Promise<Message>;
  fetcher?: FileFetcher;
  inspect(context: ToolContext, file: StoredFile, bytes: Uint8Array, question: string): Promise<string>;
  send(context: ToolContext, file: StoredFile, bytes: Uint8Array): Promise<void>;
  sandbox?: { read(context: ToolContext, path: string): Promise<Uint8Array>; write(context: ToolContext, path: string, bytes: Uint8Array): Promise<void> };
  /** Needed by to_sandbox. Without both, to_sandbox returns "Sandbox is not configured.". */
  store?: RecordStore;
  provider?: SandboxProvider;
}
const readActions = ['list', 'info', 'read', 'link'];
export function objectStorageTool(services: StorageServices): ToolDefinition {
  const fetcher = services.fetcher ?? new DiscordFileFetcher();
  return {
    name: 'file_store',
    description: 'Persistent files scoped to a user across servers, a shared server directory, or a user within this server. Save Discord attachments, text or sandbox outputs; list, inspect, download, DM files back, copy shared files, publish/unpublish, delete, or load into the sandbox. Personal files are private by default; server files are shared by default. Personal files are owner-controlled. Server files can be changed by their creator or a server admin. Publishing global user files makes them discoverable across servers.',
    access: 'member', effect: 'write', retrySafe: false, execution: 'inline',
    // Every action that is not a read changes stored files or a sandbox, so a PTC call to it needs Confirm.
    confirm: args => !readActions.includes(String(args.action)),
    fields: {
      action: { type: 'string', required: true, choices: ['save_attachment', 'write', 'save_sandbox', 'load_sandbox', 'to_sandbox', 'list', 'info', 'read', 'link', 'send', 'copy', 'publish', 'unpublish', 'delete'], description: 'File storage action. send DMs the file only to the requester.' },
      storage_scope: { type: 'string', choices: storageScopes, description: 'user: personal across servers; server: shared current-server directory; user_server: personal within current server, the default' },
      destination_scope: { type: 'string', choices: storageScopes, description: 'copy destination scope; defaults to source storage_scope. New personal copies are private; server copies are shared.' },
      path: { type: 'string', max: 300, description: 'Relative path in the selected directory, e.g. reports/result.csv' },
      owner: { type: 'string', max: 20, description: 'Discord user ID for reading/copying a public file; defaults to requester. Cannot override write ownership.' },
      scope: { type: 'string', choices: ['mine', 'public'], description: 'mine: own personal files or accessible shared-server files; public: published files in selected storage_scope. Default mine' },
      prefix: { type: 'string', max: 300, description: 'List only paths starting with this prefix' },
      limit: { type: 'integer', min: 1, max: 100, description: 'List page size, default 25' },
      offset: { type: 'integer', min: 0, max: 100000, description: 'List pagination offset, default 0' },
      message_id: { type: 'string', description: 'Discord attachment message ID; omit for current/reply attachment' },
      attachment: { type: 'integer', min: 0, max: 19, description: 'Attachment index, default 0' },
      text: { type: 'string', max: 64000, description: 'UTF-8 content for write' },
      content_type: { type: 'string', max: 100, description: 'MIME type for writes/sandbox saves, default text/plain or application/octet-stream' },
      sandbox_path: { type: 'string', max: 1024, description: 'Absolute sandbox path for save_sandbox, load_sandbox or to_sandbox' },
      destination: { type: 'string', max: 300, description: 'New path in destination_scope for copy' },
      overwrite: { type: 'boolean', description: 'Explicitly replace your existing path; personal replacement becomes private; server replacement is shared' },
      question: { type: 'string', max: 2000, description: 'Question for inspecting a stored file; images and documents are supported' },
      seconds: { type: 'integer', min: 60, max: 604800, description: 'Download link lifetime, default 3600 seconds, maximum seven days' },
    },
    writes: args => !readActions.includes(String(args.action)),
    resource: (message, args) => {
      const scope = String(args.action === 'copy' ? args.destination_scope ?? args.storage_scope ?? 'user_server' : args.storage_scope ?? 'user_server');
      return scope === 'user' ? `file-store:user:${message.author}` : scope === 'server' ? `file-store:server:${message.server}` : `file-store:${message.server}:${message.author}`;
    },
    validate(args) {
      if (args.action !== 'list') storagePath(args.path);
      if (args.owner !== undefined && (typeof args.owner !== 'string' || !/^\d{17,20}$/.test(args.owner))) throw new ToolError('owner must be a Discord user ID.');
      if (['save_attachment', 'write', 'save_sandbox', 'publish', 'unpublish', 'delete'].includes(String(args.action)) && args.owner !== undefined) throw new ToolError('Omit owner when changing files. Writes always use the requester directory.');
      if (args.storage_scope === 'server' && args.owner !== undefined) throw new ToolError('Server scope uses this server directory. Omit owner.');
      if (args.destination_scope !== undefined && args.action !== 'copy') throw new ToolError('destination_scope is only valid for copy.');
      if (args.action === 'copy') storagePath(args.destination);
      if (args.action === 'write' && typeof args.text !== 'string') throw new ToolError('write requires text.');
      if (['save_sandbox', 'load_sandbox', 'to_sandbox'].includes(String(args.action)) &&(typeof args.sandbox_path !== 'string' || !args.sandbox_path.startsWith('/') || args.sandbox_path.includes('\0'))) throw new ToolError('Provide an absolute sandbox_path.');
      if (args.content_type !== undefined && (typeof args.content_type !== 'string' || !/^[\w.+-]+\/[\w.+-]+(?:;[\x20-\x7e]+)?$/.test(args.content_type))) throw new ToolError('Provide a valid MIME content_type.');
      return args;
    },
    async authorize(context, args) {
      await services.authorize(context.message);
      // Send posts a Discord DM, so a private chat cannot use it. The other actions stay available.
      if (args.action === 'send' && isPrivateChannel(context.message.channel)) throw new ToolError(discordOnlyMessage);
      if (['info', 'read', 'link', 'send', 'copy', 'load_sandbox', 'to_sandbox'].includes(String(args.action))) await services.storage.entry(context.message.server, context.message.author, String(args.owner ?? context.message.author), String(args.path), false, (args.storage_scope ?? 'user_server') as StorageScope, context.isAdmin);
    },
    async execute(context, args) {
      const { server, author } = context.message, owner = String(args.owner ?? author), path = String(args.path), scope = (args.storage_scope ?? 'user_server') as StorageScope;
      await context.assertActive();
      if (args.action === 'list') {
        const files = await services.storage.list(server, author, String(args.scope ?? 'mine'), String(args.prefix ?? ''), typeof args.owner === 'string' ? args.owner : undefined, scope, context.isAdmin);
        const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 25), page = files.slice(offset, offset + limit);
        return { text: page.length ? page.map(file => `${fileStorageScope(file)}:${file.owner}/${file.path} | ${file.size} bytes | ${file.public ? 'public' : 'private'}`).join('\n') + `\nShowing ${offset + 1}-${offset + page.length} of ${files.length}.` : 'No matching stored files.', data: { files: page.map(metadata), total: files.length, next_offset: offset + page.length < files.length ? offset + page.length : null } };
      }
      if (args.action === 'info') return { text: JSON.stringify(metadata((await services.storage.entry(server, author, owner, path, false, scope, context.isAdmin)).file)) };
      if (args.action === 'link') {
        const seconds = Number(args.seconds ?? 3600), url = await services.storage.link(server, author, owner, path, seconds, scope, context.isAdmin);
        return { text: `Download link expires in ${seconds} seconds. Anyone with the link can read this file until then.`, artifacts: [{ url, label: path }] };
      }
      if (args.action === 'publish' || args.action === 'unpublish') {
        await services.storage.share(server, author, path, args.action === 'publish', scope, context.isAdmin);
        if (args.action === 'publish') {
          const url = await services.storage.link(server, author, author, path, Number(args.seconds ?? 3600), scope, context.isAdmin);
          return { text: `${scope}:${path} is in ${scope === 'user' ? 'the public library across servers' : 'this server public library'}. Anyone with this download link can read it until the link expires.`, artifacts: [{ url, label: path }] };
        }
        return `${path} is private again. Existing download links can still work until they expire.`;
      }
      if (args.action === 'delete') { await services.storage.remove(server, author, path, scope, context.isAdmin); return `Deleted ${path}.`; }
      if (['read', 'send', 'copy', 'load_sandbox', 'to_sandbox'].includes(String(args.action))) {
        const { file, bytes } = await services.storage.read(server, author, owner, path, scope, context.isAdmin);
        await context.assertActive();
        if (args.action === 'read') return { text: await services.inspect(context, file, bytes, String(args.question ?? context.message.text)) };
        if (args.action === 'send') { await services.send(context, file, bytes); return `Sent ${path} to you by Discord DM.`; }
        if (args.action === 'to_sandbox') {
          const store = services.store, provider = services.provider;
          if (!store || !provider) return 'Sandbox is not configured.';
          const { session } = await sandboxSession(store, provider, context.message, context.operationId);
          await session.write(String(args.sandbox_path), bytes);
          return `Copied ${path} to sandbox ${args.sandbox_path}.`;
        }
        if (args.action === 'load_sandbox') {
          if (!services.sandbox) throw new ToolError('Sandbox is not configured.');
          await services.sandbox.write(context, String(args.sandbox_path), bytes);
          return `Loaded ${path} into sandbox ${args.sandbox_path}.`;
        }
        const saved = await services.storage.save(context, String(args.destination), bytes, file.contentType, args.overwrite === true, (args.destination_scope ?? scope) as StorageScope);
        return { text: `Copied ${scope}:${owner}/${path} to ${fileStorageScope(saved)}:${saved.path} (${saved.public ? 'shared' : 'private'}).`, data: metadata(saved) };
      }
      let bytes: Uint8Array, contentType = String(args.content_type ?? (args.action === 'write' ? 'text/plain; charset=utf-8' : 'application/octet-stream'));
      let source: Message | undefined;
      if (args.action === 'save_attachment') {
        source = await services.resolveAttachment(context.message, typeof args.message_id === 'string' ? args.message_id : undefined);
        const attachment = source.attachments?.[Number(args.attachment ?? 0)];
        if (!attachment) throw new ToolError('No attachment found. Reply to its message or provide message_id.');
        bytes = await fetcher.fetch(attachment);
        contentType = attachment.contentType ?? 'application/octet-stream';
        const refreshed = await services.resolveAttachment(context.message, source.id);
        if (sourceFingerprint(refreshed, true) !== sourceFingerprint(source, true)) throw new ToolError('Attachment source changed before upload (file_source_changed). Refresh the message and try again.');
      } else if (args.action === 'save_sandbox') {
        if (!services.sandbox) throw new ToolError('Sandbox is not configured.');
        bytes = await services.sandbox.read(context, String(args.sandbox_path));
      } else bytes = Buffer.from(String(args.text), 'utf8');
      const file = await services.storage.save(context, path, bytes, contentType, args.overwrite === true, scope);
      return { text: `Saved ${scope}:${path} (${file.size} bytes, ${file.public ? 'shared' : 'private'}).`, data: metadata(file), ...(source ? { sources: [{ kind: 'message' as const, server: source.server, channel: source.channel, id: source.id }] } : {}) };
    },
  };
}
