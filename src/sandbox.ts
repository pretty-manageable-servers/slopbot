import { storagePath, storageScopes, type StorageScope, type UserFileStorage } from './object-storage.js';
import { logError } from "./errors.js";
import { DiscordFileFetcher, type FileFetcher } from './files.js';
import type { Message } from './domain.js';
import { contextChangedError, sourceFingerprint } from './source-context.js';
import type { RecordStore } from './records.js';
import { ToolError, type ToolDefinition, type ToolContext } from './tools.js';
import { requestTimings } from './request-timing.js';

export interface SandboxSession {
  id: string;
  run(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  read(path: string): Promise<string>;
  readBytes(path: string, maxBytes: number): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  renew(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}
export interface SandboxProvider {
  create(metadata: Record<string, string>, lifetimeMs: number): Promise<SandboxSession>;
  connect(id: string): Promise<SandboxSession>;
}
const lifetimeMs = 600000;
const limit = (text: string) => text.length > 16000 ? `${text.slice(0, 16000)}\n[Output truncated; use a narrower command.]` : text;
export interface SandboxAttachments {
  resolve(message: Message, id: string | undefined): Promise<Message>;
  fetcher?: FileFetcher;
}
export function sandboxTool(store: RecordStore, provider?: SandboxProvider, attachments?: SandboxAttachments, storage?: UserFileStorage): ToolDefinition {
  const fetcher = attachments?.fetcher ?? new DiscordFileFetcher();
  return {
    name: 'sandbox', description: 'Import Discord attachments or stored files, run code and read/write files in an isolated remote PMServers sandbox shared by this task thread. Reuse files across calls. Expires ten minutes after last command, file write or import. No bot credentials are forwarded. Read status before assuming a workspace still exists.',
    fields: {
      action: { type: 'string', required: true, choices: ['run', 'read', 'write', 'import_attachment', 'import_storage', 'status', 'close'], description: 'run/write/import_attachment/import_storage creates a sandbox when none is recorded; close destroys it' },
      command: { type: 'string', description: 'Shell command to execute remotely, never on the bot host' },
      path: { type: 'string', description: 'Absolute sandbox file path, e.g. /tmp/example.py' },
      storage_scope: { type: 'string', choices: storageScopes, description: 'Stored-file namespace for import_storage: user, server or user_server (default)' },
      storage_path: { type: 'string', max: 300, description: 'Relative stored-file path for import_storage' },
      owner: { type: 'string', max: 20, description: 'Stored-file owner Discord ID; defaults to requester; other users must have published the file' },
      message_id: { type: 'string', description: 'Attachment source message ID in this thread or its permitted parent channel; omit for current/reply attachment' },
      attachment: { type: 'integer', min: 0, max: 19, description: 'Zero-based attachment index, default 0' },
      text: { type: 'string', description: 'UTF-8 file content for write, at most 64000 characters' },
      seconds: { type: 'integer', min: 1, max: 60, description: 'Command timeout, default 30 seconds' },
    },
    access: 'member', effect: 'write', execution: 'thread', retrySafe: false,
    writes: args => !['read', 'status'].includes(String(args.action)),
    // Mutations share the task lock; reads remain available to inspect uncertain actions.
    resource: message => `sandbox:${message.server}:${message.channel}`,
    validate(args) {
      if (args.action === 'run' && (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000)) throw new ToolError('run requires a command of 1–16000 characters.');
      if (['read', 'write', 'import_attachment', 'import_storage'].includes(String(args.action)) && (typeof args.path !== 'string' || !args.path.startsWith('/') || args.path.includes('\0') || args.path.length > 1024)) throw new ToolError('Provide an absolute sandbox file path.');
      if (args.action === 'write' && (typeof args.text !== 'string' || args.text.length > 64000)) throw new ToolError('write requires text of at most 64000 characters.');
      if (args.storage_scope === 'server' && args.owner !== undefined) throw new ToolError('Server scope uses this server directory. Omit owner.');
      if (args.action === 'import_storage') { storagePath(args.storage_path); if (args.owner !== undefined && !/^\d{17,20}$/.test(String(args.owner))) throw new ToolError('owner must be a Discord user ID.'); }
      return args;
    },
    async authorize(context, args) {
      if (args.action === 'import_storage') {
        if (!storage) throw new ToolError('Object storage is not configured.');
        await storage.entry(context.message.server, context.message.author, String(args.owner ?? context.message.author), String(args.storage_path), false, (args.storage_scope ?? 'user_server') as StorageScope, context.isAdmin);
      }
    },
    async execute(context, args) {
      if (!provider) throw new ToolError('Sandbox is not configured. Set E2B_API_KEY to a PMServers project token.');
      await context.assertActive();
      const { message } = context;
      let imported: { source?: Message; bytes: Uint8Array; name: string } | undefined;
      if (args.action === 'import_attachment') {
        if (!attachments) throw new ToolError('Attachment import is not configured.');
        const source = await attachments.resolve(message, typeof args.message_id === 'string' ? args.message_id : undefined);
        const attachment = source.attachments?.[Number(args.attachment ?? 0)];
        if (!attachment) throw new ToolError('No attachment found. Reply to the file or provide its message ID.');
        const bytes = await requestTimings.wait('attachment download', () => fetcher.fetch(attachment));
        await context.assertActive();
        const refreshed = await attachments.resolve(message, source.id);
        if (sourceFingerprint(refreshed, true) !== sourceFingerprint(source, true)) throw contextChangedError(message, { reason: 'file_source_changed', sourceId: source.id });
        imported = { source, bytes, name: attachment.name };
      }
      if (args.action === 'import_storage') {
        if (!storage) throw new ToolError('Object storage is not configured.');
        const { file, bytes } = await storage.read(message.server, message.author, String(args.owner ?? message.author), String(args.storage_path), (args.storage_scope ?? 'user_server') as StorageScope, context.isAdmin);
        await context.assertActive();
        imported = { bytes, name: file.path };
      }
      const record = await store.record(message.server, 'sandbox', message.channel);
      const value = record?.value as { id?: string; expiresAt?: number } | undefined;
      let id = value?.id;
      if (id && (value?.expiresAt ?? 0) <= Date.now()) id = undefined;
      if (!id && ['status', 'read', 'close'].includes(String(args.action))) return 'No active sandbox recorded for this task. Run a command or write a file to create one.';
      let session: SandboxSession;
      if (id) session = await requestTimings.wait('sandbox connect', () => provider.connect(id!));
      else {
        session = await requestTimings.wait('sandbox create', () => provider.create({ server: message.server, channel: message.channel, operation: context.operationId }, lifetimeMs));
        try {
          if (!await store.putRecord(message.server, 'sandbox', message.channel, { id: session.id, expiresAt: Date.now() + lifetimeMs }, record?.revision ?? 0)) throw new ToolError('Sandbox workspace changed concurrently.');
        } catch (error) { await session.close().catch(secondary => logError("sandbox_create_cleanup_failed", secondary, { stage: "sandbox cleanup", operationId: context.operationId }, true)); throw error; }
      }
      if (args.action === 'status') return `Sandbox ${session.id} is connected. Recorded lease expires at ${new Date(value!.expiresAt!).toISOString()}.`;
      if (args.action === 'read') return { text: limit(await requestTimings.wait('sandbox read', () => session.read(String(args.path)))) };
      const fresh = await store.record(message.server, 'sandbox', message.channel);
      if (args.action === 'close') {
        await requestTimings.wait('sandbox close', () => session.close());
        if (!await store.putRecord(message.server, 'sandbox', message.channel, { closed: true }, fresh!.revision)) throw new ToolError('Sandbox record changed during close.');
        return 'Sandbox closed. Its files and processes are gone.';
      }
      await requestTimings.wait('sandbox lease', () => session.renew(lifetimeMs));
      if (!await store.putRecord(message.server, 'sandbox', message.channel, { id: session.id, expiresAt: Date.now() + lifetimeMs }, fresh!.revision)) throw new ToolError('Sandbox record changed during lease renewal.');
      if (imported) {
        await context.assertActive();
        await requestTimings.wait('sandbox attachment upload', () => session.write(String(args.path), imported!.bytes));
        return { text: `Imported ${imported.name} (${imported.bytes.length} bytes) to ${args.path} in sandbox ${session.id}.`, ...(imported.source ? { sources: [{ kind: 'message' as const, server: imported.source.server, channel: imported.source.channel, id: imported.source.id }] } : {}) };
      }
      if (args.action === 'write') {
        await requestTimings.wait('sandbox write', () => session.write(String(args.path), String(args.text)));
        return `Wrote ${args.path} in sandbox ${session.id}.`;
      }
      const output = await requestTimings.wait('sandbox command', () => session.run(String(args.command), Number(args.seconds ?? 30) * 1000));
      return { text: limit(`Exit code: ${output.exitCode}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`) };
    },
  };
}

export async function readSandboxFile(store: RecordStore, provider: SandboxProvider, context: ToolContext, path: string, maxBytes: number): Promise<Uint8Array> {
  await context.assertActive();
  const record = await store.record(context.message.server, 'sandbox', context.message.channel);
  const value = record?.value as { id?: string; expiresAt?: number } | undefined;
  if (!value?.id || (value.expiresAt ?? 0) <= Date.now()) throw new ToolError('No active sandbox in this task. Run a command or import a file first.');
  const session = await provider.connect(value.id);
  const bytes = await session.readBytes(path, maxBytes);
  const fresh = await store.record(context.message.server, 'sandbox', context.message.channel);
  if (fresh?.revision !== record?.revision) throw new ToolError('Sandbox changed while reading the file. Check its status and retry.');
  await context.assertActive();
  return bytes;
}
