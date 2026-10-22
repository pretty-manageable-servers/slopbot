import type { RecordStore } from './records.js';
import { ToolError, type ToolDefinition, type ToolContext } from './tools.js';
import { resolveSandboxPath, SANDBOX_HOME } from './sandbox-session.js';
import { requestTimings } from './request-timing.js';
import { discordTime } from './presentation/discord-time.js';

export interface SandboxSession {
  id: string;
  run(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  read(path: string): Promise<string>;
  readBytes(path: string, maxBytes: number): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  renew(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}
export interface SandboxTemplateSpec {
  name: string;
  aptPackages: string[];
  pipPackages: string[];
}
export interface SandboxProvider {
  readonly defaultTemplate?: string;
  buildTemplate?(spec: SandboxTemplateSpec): Promise<void>;
  listTemplates?(): Promise<string[]>;
  create(metadata: Record<string, string>, lifetimeMs: number, template?: string): Promise<SandboxSession>;
  connect(id: string): Promise<SandboxSession>;
}
const lifetimeMs = 600000;
const templateName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}(?::[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})?$/;
function packages(value: unknown, kind: 'apt' | 'pip'): string[] {
  if (value === undefined) return [];
  const pattern = kind === 'apt' ? /^[a-z0-9][a-z0-9+.-]*(?:=[a-zA-Z0-9+.:~_-]+)?$/ : /^[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:\[[a-zA-Z0-9_,.-]+\])?(?:==[a-zA-Z0-9_.+!-]+)?$/;
  if (!Array.isArray(value) || value.length > 40 || value.some(item => typeof item !== 'string' || item.length > 200 || !pattern.test(item))) throw new ToolError(`${kind}_packages must be an array of at most 40 package names, optionally pinned with ${kind === 'apt' ? '=' : '=='}. URLs, options and shell commands are not allowed.`);
  return [...new Set(value)] as string[];
}
const limit = (text: string) => text.length > 16000 ? `${text.slice(0, 16000)}\n[Output truncated; use a narrower command.]` : text;
/** How long a template list stays fresh, and how long to wait after a failed list before trying again. */
export const templateCacheMs = 5 * 60 * 1000;
function normalizeNames(list: readonly string[]): readonly string[] {
  return [...new Set(list.filter(name => templateName.test(name)))].sort();
}
/** Caches the project template names. Refreshes at most every five minutes, and after a template build. */
export class TemplateCatalog {
  private names: readonly string[] | undefined;
  private loadedAt = Number.NEGATIVE_INFINITY;
  private retryAt = Number.NEGATIVE_INFINITY;
  private lastError: unknown;
  private pending: Promise<readonly string[]> | undefined;
  constructor(private readonly load: () => Promise<readonly string[]>, private readonly now: () => number = Date.now, private readonly ttlMs = templateCacheMs) {}
  /** The names known now, without waiting. Starts a background refresh when the cache is stale. */
  current(): readonly string[] | undefined {
    if (!this.pending && this.now() - this.loadedAt >= this.ttlMs && this.now() >= this.retryAt) this.refresh().catch(() => undefined);
    return this.names;
  }
  /** Returns the cached names while fresh, otherwise loads them. A failed load keeps the last good names and waits before the next try. */
  refresh(): Promise<readonly string[]> {
    if (this.pending) return this.pending;
    const now = this.now();
    if (this.names && (now - this.loadedAt < this.ttlMs || now < this.retryAt)) return Promise.resolve(this.names);
    if (now < this.retryAt) return Promise.reject(this.lastError);
    this.pending = this.load().then(list => {
      this.names = normalizeNames(list);
      this.loadedAt = this.now();
      this.retryAt = Number.NEGATIVE_INFINITY;
      return this.names;
    }, error => {
      this.lastError = error;
      this.retryAt = this.now() + this.ttlMs;
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /** Marks the cache stale, so the next refresh loads again. */
  invalidate(): void {
    this.loadedAt = Number.NEGATIVE_INFINITY;
    this.retryAt = Number.NEGATIVE_INFINITY;
  }
}
const slopbotNote = 'slopbot: Python 3 with pip, venv and common data packages (numpy, pandas, requests, httpx, matplotlib, pillow, beautifulsoup4, lxml, pyyaml, openpyxl and more); Node.js LTS with npm; git, curl, wget, jq, ripgrep, fd, sqlite3, zip and build-essential.';
function templateListLine(names: readonly string[] | undefined): string {
  if (names === undefined) return 'The template list is unavailable right now.';
  return names.length ? `Templates in this project: ${names.join(', ')}.` : 'This project has no ready templates yet.';
}
function templateNote(defaultTemplate: string, names: readonly string[] | undefined): string {
  return names?.includes('slopbot') || defaultTemplate === 'slopbot' ? ` ${slopbotNote}` : '';
}
export function sandboxManageTool(store: RecordStore, provider?: SandboxProvider): ToolDefinition {
  const listTemplates = provider?.listTemplates?.bind(provider);
  const catalog = listTemplates ? new TemplateCatalog(() => listTemplates()) : undefined;
  return {
    name: 'sandbox_manage',
    description: 'Manage the sandbox of this task: templates lists the templates this PMServers project can start; build_template builds a template from apt and pip packages for later sandboxes; status shows the task sandbox; close deletes its files and processes. The read, write, edit and shell tools start the sandbox. Template sandboxes run as a non-root user in its home directory; sudo is unavailable, so install packages at build time.',
    fields: {
      action: { type: 'string', required: true, choices: ['templates', 'build_template', 'status', 'close'], description: 'templates lists templates; build_template builds one; status shows the task sandbox; close deletes it and its files' },
      template: { type: 'string', max: 129, description: 'build_template only: name or name:tag of the new template. Required for build_template.' },
      apt_packages: { type: 'json', schema: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 200 } }, description: 'build_template only: Ubuntu package names, optionally name=version, e.g. ["python3", "python3-pip", "ffmpeg"]' },
      pip_packages: { type: 'json', schema: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 200 } }, description: 'build_template only: Python packages, optionally name==version, e.g. ["numpy", "pandas"]' },
    },
    access: 'member', effect: 'write', execution: 'inline', retrySafe: false,
    // An uncertain create or command is an orphan or a lost result that expires on its own within this time.
    staleAfterMs: lifetimeMs,
    writes: args => !['status', 'templates'].includes(String(args.action)),
    // Template builds share a lock per template. Other actions share the task lock.
    resource: (message, args) => args.action === 'build_template' ? `sandbox-template:${String(args.template)}` : `sandbox:${message.server}:${message.channel}`,
    validate(args) {
      if (args.template !== undefined && (typeof args.template !== 'string' || !templateName.test(args.template))) throw new ToolError('template must be a name or name:tag using letters, digits, dots, underscores and hyphens.');
      if (args.action === 'build_template') {
        if (!args.template) throw new ToolError('build_template requires a template name.');
        packages(args.apt_packages, 'apt'); packages(args.pip_packages, 'pip');
      } else {
        if (args.template !== undefined) throw new ToolError('template is only valid for build_template.');
        if (args.apt_packages !== undefined || args.pip_packages !== undefined) throw new ToolError('Package lists are only supported by build_template.');
      }
      return args;
    },
    async execute(context, args) {
      if (!provider) throw new ToolError('Sandbox is not configured. Set E2B_API_KEY to a PMServers project token.');
      await context.assertActive();
      const { message } = context;
      if (args.action === 'templates') {
        const defaultTemplate = provider.defaultTemplate ?? 'base';
        const listed = await catalog?.refresh().catch(() => undefined);
        if (listed) return limit(`Default template: ${defaultTemplate}. ${templateListLine(listed)}${templateNote(defaultTemplate, listed)}`);
        // The PMServers list could not be read, so fall back to the templates this server recorded.
        const records = await store.records(message.server, 'sandbox-template');
        const names = records.map(record => {
          const spec = record.value as {aptPackages?: string[]; pipPackages?: string[]};
          return `${record.id} (apt: ${spec.aptPackages?.join(', ') || 'none'}; pip: ${spec.pipPackages?.join(', ') || 'none'})`;
        });
        return limit(`Default template: ${defaultTemplate}. The PMServers template list could not be read. Templates built by this server (local records): ${names.join(', ') || 'none recorded'}.`);
      }
      if (args.action === 'build_template') {
        if (!provider.buildTemplate) throw new ToolError('Template builds are not supported by this sandbox provider.');
        const spec = { name: String(args.template), aptPackages: packages(args.apt_packages, 'apt'), pipPackages: packages(args.pip_packages, 'pip') };
        const previous = await store.record(message.server, 'sandbox-template', spec.name);
        await requestTimings.wait('sandbox template build', () => provider.buildTemplate!(spec));
        await context.assertActive();
        if (!await store.putRecord(message.server, 'sandbox-template', spec.name, { aptPackages: spec.aptPackages, pipPackages: spec.pipPackages, builtAt: Date.now() }, previous?.revision ?? 0)) throw new ToolError('Template built, but its local record changed concurrently. Use the template name to create a sandbox.');
        // A new build changes the project list, so reload it now.
        catalog?.invalidate();
        await catalog?.refresh().catch(() => undefined);
        return `Template ${spec.name} built with Ubuntu 24.04. apt: ${spec.aptPackages.join(', ') || 'none'}; pip: ${spec.pipPackages.join(', ') || 'none'}. No workspace was replaced.`;
      }
      // status and close only use a sandbox that exists. They never start one.
      const record = await store.record(message.server, 'sandbox', message.channel);
      const value = record?.value as { id?: string; expiresAt?: number; template?: string } | undefined;
      const id = value?.id && (value.expiresAt ?? 0) > Date.now() ? value.id : undefined;
      if (!id) return 'No active sandbox in this task. The read, write, edit and shell tools start one.';
      const session = await requestTimings.wait('sandbox connect', () => provider.connect(id));
      if (args.action === 'status') return `Sandbox ${session.id} is connected. Template: ${value?.template ?? 'unknown (legacy workspace)'}. Recorded lease expires at ${discordTime(value!.expiresAt!)}.`;
      const fresh = await store.record(message.server, 'sandbox', message.channel);
      await requestTimings.wait('sandbox close', () => session.close());
      if (!await store.putRecord(message.server, 'sandbox', message.channel, { closed: true }, fresh!.revision)) throw new ToolError('Sandbox record changed during close.');
      return 'Sandbox closed. Its files and processes are gone.';
    },
  };
}

/** Reads a sandbox file. Relative paths and ~ start in the profile home when given, else in the home recorded for this task's sandbox. */
export async function readSandboxFile(store: RecordStore, provider: SandboxProvider, context: ToolContext, path: string, maxBytes: number, profileHome?: string): Promise<Uint8Array> {
  await context.assertActive();
  const record = await store.record(context.message.server, 'sandbox', context.message.channel);
  const value = record?.value as { id?: string; expiresAt?: number; home?: string } | undefined;
  if (!value?.id || (value.expiresAt ?? 0) <= Date.now()) throw new ToolError('No active sandbox in this task. Run a command or import a file first.');
  const session = await provider.connect(value.id);
  const bytes = await session.readBytes(resolveSandboxPath(path, profileHome ?? value.home ?? SANDBOX_HOME), maxBytes);
  const fresh = await store.record(context.message.server, 'sandbox', context.message.channel);
  if (fresh?.revision !== record?.revision) throw new ToolError('Sandbox changed while reading the file. Check its status and retry.');
  await context.assertActive();
  return bytes;
}
