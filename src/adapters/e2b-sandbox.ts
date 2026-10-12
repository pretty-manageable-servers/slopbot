import { Sandbox, CommandExitError, ServiceBusyError, AuthenticationError } from 'e2b';
import type { SandboxProvider, SandboxSession } from '../sandbox.js';
import { ToolError, UncertainActionError } from '../tools.js';
export interface E2BOptions { apiKey: string; apiUrl: string; sandboxUrl: string; template?: string }
export class E2BSandboxProvider implements SandboxProvider {
  constructor(private readonly options: E2BOptions) {}
  private connection() {
    return { debug: false, apiKey: this.options.apiKey, apiUrl: this.options.apiUrl, sandboxUrl: this.options.sandboxUrl, requestTimeoutMs: 30000 };
  }
  async create(metadata: Record<string, string>, lifetimeMs: number): Promise<SandboxSession> {
    try {
      return this.wrap(await Sandbox.create({ ...this.connection(), template: this.options.template ?? 'base', metadata, timeoutMs: lifetimeMs }));
    } catch (error) {
      if (error instanceof ServiceBusyError) throw new ToolError('PMServers sandbox capacity is being prepared or is busy. Try again in a few minutes.', 'failed', { cause: error });
      if (error instanceof AuthenticationError) throw new ToolError('Sandbox authentication failed. Check the configured project token.', 'failed', { cause: error });
      throw new UncertainActionError('Sandbox creation could not be confirmed. Any orphan expires automatically; do not blindly retry.', { cause: error }); }
  }
  async connect(id: string): Promise<SandboxSession> {
    try { return this.wrap(await Sandbox.connect(id, this.connection())); }
    catch (error) { throw new ToolError('Sandbox could not be connected. It may have expired or the provider may be unavailable.', 'failed', { cause: error }); }
  }
  private wrap(sandbox: Sandbox): SandboxSession {
    const read = async <T>(work: () => Promise<T>) => {
      try { return await work(); } catch (error) { throw new ToolError('Sandbox read or lease request failed. Check workspace status.', 'failed', { cause: error }); }
    };
    const write = async <T>(work: () => Promise<T>) => {
      try { return await work(); } catch (error) { throw new UncertainActionError('Sandbox action could not be confirmed. Inspect workspace state before retrying.', { cause: error }); }
    };
    return {
      id: sandbox.sandboxId,
      run: async (command, timeoutMs) => {
        try { const result = await sandbox.commands.run(command, { timeoutMs, requestTimeoutMs: timeoutMs + 5000 }); return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }; }
        catch (error) {
          if (error instanceof CommandExitError) return { stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode };
          throw new UncertainActionError('Sandbox command timed out or its result was lost. It may have run; inspect state before retrying.', { cause: error });
        }
      },
      read: path => read(() => sandbox.files.read(path)),
      readBytes: (path, maxBytes) => read(async () => {
        const stream = await sandbox.files.read(path, { format: 'stream' });
        const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > maxBytes) throw new ToolError('Sandbox file exceeds the 10 MiB storage limit.'); chunks.push(chunk.value); }
          return Buffer.concat(chunks);
        } finally { await reader.cancel(); }
      }),
      write: (path, data) => write(async () => { await sandbox.files.write(path, typeof data === 'string' ? data : Uint8Array.from(data).buffer); }),
      renew: timeoutMs => read(() => sandbox.setTimeout(timeoutMs)),
      close: () => write(async () => { await sandbox.kill(); }),
    };
  }
}
