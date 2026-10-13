import { Sandbox, CommandExitError, ServiceBusyError, AuthenticationError, Template, TemplateBase, BuildError, InvalidArgumentError, TemplateError, RateLimitError, NotFoundError, SandboxError } from 'e2b';
import type { SandboxProvider, SandboxSession, SandboxTemplateSpec } from '../sandbox.js';
import { ToolError, UncertainActionError } from '../tools.js';
export interface E2BOptions { apiKey: string; apiUrl: string; sandboxUrl: string; template?: string }
/** A 4xx answer from the API means the request was refused, so no sandbox was created. Timeouts (408) stay uncertain. */
function refusedStatus(error: unknown): number | undefined {
  const status = error instanceof SandboxError ? error.statusCode : undefined;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 ? status : undefined;
}
function refusalError(status: number, template: string | undefined, defaultTemplate: string, cause: unknown): ToolError {
  if (status === 404) return template
    ? new ToolError(`Sandbox template "${template}" does not exist. Use action "templates" to list templates, or omit template to use the default.`, 'rejected', { cause })
    : new ToolError(`The default sandbox template "${defaultTemplate}" does not exist on PMServers. Ask the server admin to check the sandbox configuration.`, 'rejected', { cause });
  if (status === 401 || status === 403) return new ToolError(`PMServers refused the sandbox request (HTTP ${status}). Check the configured project token.`, 'failed', { cause });
  return new ToolError(`PMServers rejected the sandbox request (HTTP ${status}). No sandbox was created. Check the template name and try again.`, 'rejected', { cause });
}
export class E2BSandboxProvider implements SandboxProvider {
  constructor(private readonly options: E2BOptions) {}
  private connection() {
    return { debug: false, apiKey: this.options.apiKey, apiUrl: this.options.apiUrl, sandboxUrl: this.options.sandboxUrl, requestTimeoutMs: 30000 };
  }
  get defaultTemplate(): string { return this.options.template ?? 'base'; }
  /** Lists the template names and aliases this project can start, from the API. Only ready templates count. */
  async listTemplates(): Promise<string[]> {
    const names: string[] = [];
    const base = this.options.apiUrl.replace(/\/+$/, '');
    let nextToken: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${base}/v2/templates`);
      url.searchParams.set('limit', '100');
      if (nextToken) url.searchParams.set('nextToken', nextToken);
      const response = await fetch(url, { headers: { 'X-API-Key': this.options.apiKey }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Template list failed with HTTP ${response.status}.`);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error('Template list has an unexpected shape.');
      for (const item of body as Array<{ buildStatus?: unknown; names?: unknown; aliases?: unknown }>) {
        if (item.buildStatus !== undefined && item.buildStatus !== 'ready') continue;
        for (const value of [...(Array.isArray(item.names) ? item.names : []), ...(Array.isArray(item.aliases) ? item.aliases : [])]) if (typeof value === 'string') names.push(value);
      }
      nextToken = response.headers.get('X-Next-Token');
      if (!nextToken) break;
    }
    return [...new Set(names)];
  }
  async buildTemplate(spec: SandboxTemplateSpec): Promise<void> {
    try {
      let builder = Template().fromUbuntuImage('24.04');
      const apt = [...new Set([...spec.aptPackages, ...(spec.pipPackages.length ? ['python3', 'python3-venv'] : [])])];
      if (apt.length) builder = builder.aptInstall(apt);
      if (spec.pipPackages.length) {
        // Ubuntu 24.04 protects its system Python; install into a shared venv.
        builder = builder.runCmd('python3 -m venv /opt/slopbot-python', { user: 'root' })
          .setEnvs({ VIRTUAL_ENV: '/opt/slopbot-python', PATH: '/opt/slopbot-python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' })
          .pipInstall(spec.pipPackages);
      }
      await TemplateBase.build(builder, spec.name, { ...this.connection(), signal: AbortSignal.timeout(300000) });
    } catch (error) {
      if (error instanceof BuildError || error instanceof InvalidArgumentError || error instanceof TemplateError) throw new ToolError('Sandbox template build failed. Check the requested package names and versions.', 'failed', { cause: error });
      if (error instanceof AuthenticationError) throw new ToolError('Sandbox template authentication failed. Check the configured project token.', 'failed', { cause: error });
      if (error instanceof ServiceBusyError || error instanceof RateLimitError) throw new ToolError('Sandbox template service is busy. Try again later.', 'failed', { cause: error });
      throw new UncertainActionError('Template build could not be confirmed. Inspect the template in PMServers before rebuilding the same name.', { cause: error });
    }
  }
  async create(metadata: Record<string, string>, lifetimeMs: number, template?: string): Promise<SandboxSession> {
    try {
      return this.wrap(await Sandbox.create(template ?? this.defaultTemplate, { ...this.connection(), metadata, timeoutMs: lifetimeMs }));
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof InvalidArgumentError || error instanceof TemplateError) throw new ToolError('Sandbox template was not found or is invalid. Use an existing template name or name:tag from the configured PMServers project.', 'failed', { cause: error });
      if (error instanceof RateLimitError) throw new ToolError('PMServers sandbox limit reached. Close an unused workspace and try again.', 'failed', { cause: error });
      if (error instanceof ServiceBusyError) throw new ToolError('PMServers sandbox capacity is being prepared or is busy. Try again in a few minutes.', 'failed', { cause: error });
      if (error instanceof AuthenticationError) throw new ToolError('Sandbox authentication failed. Check the configured project token.', 'failed', { cause: error });
      const status = refusedStatus(error);
      if (status !== undefined) throw refusalError(status, template, this.defaultTemplate, error);
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
