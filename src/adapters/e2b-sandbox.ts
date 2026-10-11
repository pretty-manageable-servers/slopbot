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
      if (error instanceof ServiceBusyError) throw new ToolError('PMServers sandbox capacity is being prepared or is busy. Try again in a few minutes.');
      if (error instanceof AuthenticationError) throw new ToolError('Sandbox authentication failed. Check the configured project token.');
      throw new UncertainActionError('Sandbox creation could not be confirmed. Any orphan expires automatically; do not blindly retry.'); }
  }
  async connect(id: string): Promise<SandboxSession> {
    try { return this.wrap(await Sandbox.connect(id, this.connection())); }
    catch { throw new ToolError('Sandbox could not be connected. It may have expired or the provider may be unavailable.'); }
  }
  private wrap(sandbox: Sandbox): SandboxSession {
    const read = async <T>(work: () => Promise<T>) => {
      try { return await work(); } catch { throw new ToolError('Sandbox read or lease request failed. Check workspace status.'); }
    };
    const write = async <T>(work: () => Promise<T>) => {
      try { return await work(); } catch { throw new UncertainActionError('Sandbox action could not be confirmed. Inspect workspace state before retrying.'); }
    };
    return {
      id: sandbox.sandboxId,
      run: async (command, timeoutMs) => {
        try { const result = await sandbox.commands.run(command, { timeoutMs, requestTimeoutMs: timeoutMs + 5000 }); return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }; }
        catch (error) {
          if (error instanceof CommandExitError) return { stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode };
          throw new UncertainActionError('Sandbox command timed out or its result was lost. It may have run; inspect state before retrying.');
        }
      },
      read: path => read(() => sandbox.files.read(path)),
      write: (path, text) => write(async () => { await sandbox.files.write(path, text); }),
      renew: timeoutMs => read(() => sandbox.setTimeout(timeoutMs)),
      close: () => write(async () => { await sandbox.kill(); }),
    };
  }
}
