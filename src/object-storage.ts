import { logError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type { Json, Message } from './domain.js';
import type { RecordStore, AppRecord } from './records.js';
import { ToolError, type ToolContext, type ToolDefinition } from './tools.js';
import { DiscordFileFetcher, type FileFetcher } from './files.js';
import { sourceFingerprint } from './source-context.js';

export const MAX_STORED_FILE_BYTES = 10 * 1024 * 1024;
export interface ObjectStorageProvider {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  link(key: string, name: string, seconds: number): Promise<string>;
}
export interface StoredFile {
  owner: string; path: string; key: string; size: number; contentType: string;
  public: boolean; updatedAt: number; deleted?: boolean;
}
const kind = 'stored_file';
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
  async entry(server: string, requester: string, owner: string, path: string, write = false): Promise<{ record: AppRecord; file: StoredFile }> {
    this.configured();
    const record = await this.store.record(server, kind, id(owner, storagePath(path)));
    const file = record?.value as unknown as StoredFile | undefined;
    if (write && owner !== requester) throw new ToolError('You can only change files in your own directory.');
    if (!record || !file || file.deleted || (owner !== requester && !file.public)) throw new ToolError('Stored file not found or not shared with you.');
    return { record, file };
  }
  async list(server: string, requester: string, scope: string, prefix: string, owner?: string): Promise<StoredFile[]> {
    this.configured();
    const entries = await this.store.records(server, kind);
    return entries.map(record => record.value as unknown as StoredFile).filter(file => !file.deleted && (scope === 'public' ? file.public : file.owner === requester) && (!owner || file.owner === owner) && file.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path) || a.owner.localeCompare(b.owner));
  }
  async save(context: ToolContext, path: string, bytes: Uint8Array, contentType: string, overwrite = false): Promise<StoredFile> {
    const provider = this.configured();
    path = storagePath(path);
    if (bytes.length > MAX_STORED_FILE_BYTES) throw new ToolError('Stored files are limited to 10 MiB.');
    if (!/^[\w.+-]+\/[\w.+-]+(?:;[\x20-\x7e]+)?$/.test(contentType)) throw new ToolError('Provide a valid MIME content_type.');
    const owner = context.message.author, server = context.message.server;
    const previous = await this.store.record(server, kind, id(owner, path));
    const priorFile = previous?.value as unknown as StoredFile | undefined;
    if (priorFile && !priorFile.deleted && !overwrite) throw new ToolError('That path already exists. Use another path or explicitly set overwrite:true.');
    // Immutable blobs keep concurrent saves and old download URLs from exposing a replacement.
    const key = `servers/${encodeURIComponent(server)}/users/${encodeURIComponent(owner)}/${randomUUID()}/${path}`;
    const file: StoredFile = { owner, path, key, size: bytes.length, contentType, public: false, updatedAt: Date.now() };
    await context.assertActive();
    await provider.put(key, bytes, contentType);
    try {
      await context.assertActive();
      if (!await this.store.putRecord(server, kind, id(owner, path), file as unknown as Json, previous?.revision ?? 0)) throw new ToolError('Stored file changed concurrently. Reload its metadata before trying again.');
    } catch (error) {
      await provider.delete(key).catch(cleanup => logError('storage_uncommitted_blob_cleanup_failed', cleanup, { operationId: context.operationId, server, tool: 'file_store' }, true));
      throw error;
    }
    // A committed replacement stays committed if removal of the superseded blob fails.
    if (priorFile && !priorFile.deleted) await provider.delete(priorFile.key).catch(error => logError('storage_superseded_blob_cleanup_failed', error, { operationId: context.operationId, server, tool: 'file_store' }, true));
    return file;
  }
  async read(server: string, requester: string, owner: string, path: string): Promise<{ file: StoredFile; bytes: Uint8Array }> {
    const { file } = await this.entry(server, requester, owner, path);
    const bytes = await this.configured().get(file.key);
    if (bytes.length > MAX_STORED_FILE_BYTES) throw new ToolError('Stored files are limited to 10 MiB.');
    const current = await this.entry(server, requester, owner, path);
    if (current.file.key !== file.key) throw new ToolError('Stored file changed while downloading. Read its current version.');
    return { file, bytes };
  }
  async share(server: string, requester: string, path: string, visible: boolean): Promise<StoredFile> {
    const { record, file } = await this.entry(server, requester, requester, path, true);
    const updated = { ...file, public: visible };
    if (!await this.store.putRecord(server, kind, id(requester, path), updated as unknown as Json, record.revision)) throw new ToolError('Stored file changed concurrently. Reload its metadata.');
    return updated;
  }
  async remove(server: string, requester: string, path: string): Promise<void> {
    this.configured();
    const record = await this.store.record(server, kind, id(requester, storagePath(path)));
    if (!record) throw new ToolError('Stored file not found or not shared with you.');
    const file = record.value as unknown as StoredFile;
    // Revoke bot access before deleting bytes. An unconfirmed delete remains journaled.
    if (!await this.store.putRecord(server, kind, id(requester, path), { ...file, deleted: true, public: false } as unknown as Json, record.revision)) throw new ToolError('Stored file changed concurrently. Reload its metadata.');
    await this.configured().delete(file.key);
  }
  async link(server: string, requester: string, owner: string, path: string, seconds: number): Promise<string> {
    const { file } = await this.entry(server, requester, owner, path);
    const url = await this.configured().link(file.key, file.path.split('/').at(-1)!, seconds);
    const current = await this.entry(server, requester, owner, path);
    if (current.file.key !== file.key) throw new ToolError('Stored file changed while signing its download link.');
    return url;
  }
}
const metadata = (file: StoredFile) => ({ owner: file.owner, path: file.path, size: file.size, content_type: file.contentType, public: file.public, updated_at: new Date(file.updatedAt).toISOString() });
export interface StorageServices {
  storage: UserFileStorage;
  authorize(message: Message): Promise<void>;
  resolveAttachment(message: Message, id: string | undefined): Promise<Message>;
  fetcher?: FileFetcher;
  inspect(context: ToolContext, file: StoredFile, bytes: Uint8Array, question: string): Promise<string>;
  send(context: ToolContext, file: StoredFile, bytes: Uint8Array): Promise<void>;
  sandbox?: { read(context: ToolContext, path: string): Promise<Uint8Array>; write(context: ToolContext, path: string, bytes: Uint8Array): Promise<void> };
}
const readActions = ['list', 'info', 'read', 'link'];
export function objectStorageTool(services: StorageServices): ToolDefinition {
  const fetcher = services.fetcher ?? new DiscordFileFetcher();
  return {
    name: 'file_store',
    description: 'Persistent user files. Save Discord attachments, text or sandbox outputs; list, inspect, download, DM files back, copy shared files, publish/unpublish, delete, or load into the sandbox. Private by default. Public means discoverable by this server and shareable with expiring links. Only the requester can change their own directory.',
    access: 'member', effect: 'write', retrySafe: false,
    fields: {
      action: { type: 'string', required: true, choices: ['save_attachment', 'write', 'save_sandbox', 'load_sandbox', 'list', 'info', 'read', 'link', 'send', 'copy', 'publish', 'unpublish', 'delete'], description: 'File storage action. send DMs the file only to the requester.' },
      path: { type: 'string', max: 300, description: 'Relative path in the owner directory, e.g. reports/result.csv' },
      owner: { type: 'string', max: 20, description: 'Discord user ID for reading/copying a public file; defaults to requester. Cannot override write ownership.' },
      scope: { type: 'string', choices: ['mine', 'public'], description: 'List your own files or this server public library; default mine' },
      prefix: { type: 'string', max: 300, description: 'List only paths starting with this prefix' },
      limit: { type: 'integer', min: 1, max: 100, description: 'List page size, default 25' },
      offset: { type: 'integer', min: 0, max: 100000, description: 'List pagination offset, default 0' },
      message_id: { type: 'string', description: 'Discord attachment message ID; omit for current/reply attachment' },
      attachment: { type: 'integer', min: 0, max: 19, description: 'Attachment index, default 0' },
      text: { type: 'string', max: 64000, description: 'UTF-8 content for write' },
      content_type: { type: 'string', max: 100, description: 'MIME type for writes/sandbox saves, default text/plain or application/octet-stream' },
      sandbox_path: { type: 'string', max: 1024, description: 'Absolute sandbox path for save_sandbox or load_sandbox' },
      destination: { type: 'string', max: 300, description: 'New path in your own directory for copy' },
      overwrite: { type: 'boolean', description: 'Explicitly replace your existing path; replacement becomes private' },
      question: { type: 'string', max: 2000, description: 'Question for inspecting a stored file; images and documents are supported' },
      seconds: { type: 'integer', min: 60, max: 604800, description: 'Download link lifetime, default 3600 seconds, maximum seven days' },
    },
    writes: args => !readActions.includes(String(args.action)),
    resource: message => `file-store:${message.server}:${message.author}`,
    validate(args) {
      if (args.action !== 'list') storagePath(args.path);
      if (args.owner !== undefined && (typeof args.owner !== 'string' || !/^\d{17,20}$/.test(args.owner))) throw new ToolError('owner must be a Discord user ID.');
      if (['save_attachment', 'write', 'save_sandbox', 'publish', 'unpublish', 'delete'].includes(String(args.action)) && args.owner !== undefined) throw new ToolError('Omit owner when changing files. Writes always use the requester directory.');
      if (args.action === 'copy') storagePath(args.destination);
      if (args.action === 'write' && typeof args.text !== 'string') throw new ToolError('write requires text.');
      if (['save_sandbox', 'load_sandbox'].includes(String(args.action)) && (typeof args.sandbox_path !== 'string' || !args.sandbox_path.startsWith('/') || args.sandbox_path.includes('\0'))) throw new ToolError('Provide an absolute sandbox_path.');
      if (args.content_type !== undefined && (typeof args.content_type !== 'string' || !/^[\w.+-]+\/[\w.+-]+(?:;[\x20-\x7e]+)?$/.test(args.content_type))) throw new ToolError('Provide a valid MIME content_type.');
      return args;
    },
    async authorize(context, args) {
      await services.authorize(context.message);
      if (['info', 'read', 'link', 'send', 'copy', 'load_sandbox'].includes(String(args.action))) await services.storage.entry(context.message.server, context.message.author, String(args.owner ?? context.message.author), String(args.path));
    },
    async execute(context, args) {
      const { server, author } = context.message, owner = String(args.owner ?? author), path = String(args.path);
      await context.assertActive();
      if (args.action === 'list') {
        const files = await services.storage.list(server, author, String(args.scope ?? 'mine'), String(args.prefix ?? ''), typeof args.owner === 'string' ? args.owner : undefined);
        const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 25), page = files.slice(offset, offset + limit);
        return { text: page.length ? page.map(file => `${file.owner}/${file.path} | ${file.size} bytes | ${file.public ? 'public' : 'private'}`).join('\n') + `\nShowing ${offset + 1}-${offset + page.length} of ${files.length}.` : 'No matching stored files.', data: { files: page.map(metadata), total: files.length, next_offset: offset + page.length < files.length ? offset + page.length : null } };
      }
      if (args.action === 'info') return { text: JSON.stringify(metadata((await services.storage.entry(server, author, owner, path)).file)) };
      if (args.action === 'link') {
        const seconds = Number(args.seconds ?? 3600), url = await services.storage.link(server, author, owner, path, seconds);
        return { text: `Download link expires in ${seconds} seconds. Anyone with the link can read this file until then.`, artifacts: [{ url, label: path }] };
      }
      if (args.action === 'publish' || args.action === 'unpublish') {
        await services.storage.share(server, author, path, args.action === 'publish');
        if (args.action === 'publish') {
          const url = await services.storage.link(server, author, author, path, Number(args.seconds ?? 3600));
          return { text: `${path} is in this server's public library. Anyone with this download link can read it until the link expires.`, artifacts: [{ url, label: path }] };
        }
        return `${path} is private again. Existing download links can still work until they expire.`;
      }
      if (args.action === 'delete') { await services.storage.remove(server, author, path); return `Deleted ${path}.`; }
      if (['read', 'send', 'copy', 'load_sandbox'].includes(String(args.action))) {
        const { file, bytes } = await services.storage.read(server, author, owner, path);
        await context.assertActive();
        if (args.action === 'read') return { text: await services.inspect(context, file, bytes, String(args.question ?? context.message.text)) };
        if (args.action === 'send') { await services.send(context, file, bytes); return `Sent ${path} to you by Discord DM.`; }
        if (args.action === 'load_sandbox') {
          if (!services.sandbox) throw new ToolError('Sandbox is not configured.');
          await services.sandbox.write(context, String(args.sandbox_path), bytes);
          return `Loaded ${path} into sandbox ${args.sandbox_path}.`;
        }
        const saved = await services.storage.save(context, String(args.destination), bytes, file.contentType, args.overwrite === true);
        return { text: `Copied ${owner}/${path} into your private directory at ${saved.path}.`, data: metadata(saved) };
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
      const file = await services.storage.save(context, path, bytes, contentType, args.overwrite === true);
      return { text: `Saved ${path} (${file.size} bytes) in your private directory.`, data: metadata(file), ...(source ? { sources: [{ kind: 'message' as const, server: source.server, channel: source.channel, id: source.id }] } : {}) };
    },
  };
}
