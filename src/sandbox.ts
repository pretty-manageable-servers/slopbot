import type { RecordStore } from './records.js';
import { ToolError, type ToolDefinition } from './tools.js';
import { requestTimings } from './request-timing.js';

export interface SandboxSession {
  id: string;
  run(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  renew(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}
export interface SandboxProvider {
  create(metadata: Record<string, string>, lifetimeMs: number): Promise<SandboxSession>;
  connect(id: string): Promise<SandboxSession>;
}
const lifetimeMs = 600000;
const limit = (text: string) => text.length > 16000 ? `${text.slice(0, 16000)}\n[Output truncated; use a narrower command.]` : text;
export function sandboxTool(store: RecordStore, provider?: SandboxProvider): ToolDefinition {
  return {
    name: 'sandbox', description: 'Run code and read/write files in an isolated remote PMServers sandbox shared by this task thread. Reuse files across calls. Expires ten minutes after last command or file write. No bot credentials are forwarded. Read status before assuming a workspace still exists.',
    fields: {
      action: { type: 'string', required: true, choices: ['run', 'read', 'write', 'status', 'close'], description: 'run/write creates a sandbox when none is recorded; close destroys it' },
      command: { type: 'string', description: 'Shell command to execute remotely, never on the bot host' },
      path: { type: 'string', description: 'Absolute sandbox file path, e.g. /tmp/example.py' },
      text: { type: 'string', description: 'UTF-8 file content for write, at most 64000 characters' },
      seconds: { type: 'integer', min: 1, max: 60, description: 'Command timeout, default 30 seconds' },
    },
    access: 'member', effect: 'write', execution: 'thread', retrySafe: false,
    writes: args => !['read', 'status'].includes(String(args.action)),
    // Mutations share the task lock; reads remain available to inspect uncertain actions.
    resource: message => `sandbox:${message.server}:${message.channel}`,
    validate(args) {
      if (args.action === 'run' && (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000)) throw new ToolError('run requires a command of 1–16000 characters.');
      if (['read', 'write'].includes(String(args.action)) && (typeof args.path !== 'string' || !args.path.startsWith('/') || args.path.includes('\0') || args.path.length > 1024)) throw new ToolError('Provide an absolute sandbox file path.');
      if (args.action === 'write' && (typeof args.text !== 'string' || args.text.length > 64000)) throw new ToolError('write requires text of at most 64000 characters.');
      return args;
    },
    async execute(context, args) {
      if (!provider) throw new ToolError('Sandbox is not configured. Set E2B_API_KEY to a PMServers project token.');
      await context.assertActive();
      const { message } = context;
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
        } catch (error) { await session.close().catch(() => undefined); throw error; }
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
      if (args.action === 'write') {
        await requestTimings.wait('sandbox write', () => session.write(String(args.path), String(args.text)));
        return `Wrote ${args.path} in sandbox ${session.id}.`;
      }
      const output = await requestTimings.wait('sandbox command', () => session.run(String(args.command), Number(args.seconds ?? 30) * 1000));
      return { text: limit(`Exit code: ${output.exitCode}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`) };
    },
  };
}
