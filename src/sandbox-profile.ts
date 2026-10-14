import { logError } from './errors.js';
import { isSandboxHome, SANDBOX_LIFETIME_MS } from './sandbox-session.js';
import type { SandboxProvider, SandboxSession } from './sandbox.js';

/** What the default sandbox template provides. Probed once at startup and kept in memory. */
export interface SandboxProfile { template: string; user: string; home: string; os: string; installed: string[] }

/** The probe, including its sandbox start, waits at most this long, so a slow provider never holds up startup. */
export const PROFILE_PROBE_MS = 60000;
const commandMs = 30000;
const probedTools = ['python3', 'node', 'npm', 'git', 'curl', 'jq', 'rg', 'fd', 'sqlite3', 'pdftotext', 'pandoc', 'ffmpeg'] as const;
const probeCommand = [
  'echo "user=$(id -un)"',
  'echo "home=$HOME"',
  'echo "os=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"',
  ...probedTools.map(tool => `if command -v ${tool} >/dev/null 2>&1; then echo "tool=${tool}"; fi`),
  'true',
].join('; ');

/** Reads the probe output. Returns undefined when user, home or os is missing or unusable. */
export function parseSandboxProfile(template: string, output: string): SandboxProfile | undefined {
  const fields = new Map<string, string>();
  const installed: string[] = [];
  for (const line of output.split('\n')) {
    const at = line.indexOf('=');
    if (at < 0) continue;
    const key = line.slice(0, at), value = line.slice(at + 1).trim();
    if (key === 'tool') { if ((probedTools as readonly string[]).includes(value)) installed.push(value); }
    else fields.set(key, value);
  }
  const user = fields.get('user') ?? '', home = fields.get('home') ?? '', os = fields.get('os') ?? '';
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(user) || !isSandboxHome(home) || !os || os.length > 120) return undefined;
  return { template, user, home, os, installed: [...new Set(installed)].sort() };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Sandbox profile probe timed out.')), ms); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Starts one sandbox from the default template, reads its profile and closes it. Returns undefined on any failure, and logs it. */
export async function probeSandboxProfile(provider: SandboxProvider): Promise<SandboxProfile | undefined> {
  const template = provider.defaultTemplate ?? 'base';
  const state: { session?: SandboxSession; timedOut: boolean } = { timedOut: false };
  const work = (async () => {
    const session = await provider.create({ purpose: 'profile' }, SANDBOX_LIFETIME_MS, template);
    state.session = session;
    // A sandbox that starts after the time limit is closed here, so it does not wait for its lease.
    if (state.timedOut) { await session.close().catch(() => undefined); return undefined; }
    const output = await session.run(probeCommand, commandMs);
    return output.exitCode === 0 ? parseSandboxProfile(template, output.stdout) : undefined;
  })();
  try {
    const profile = await withTimeout(work, PROFILE_PROBE_MS);
    if (!profile) logError('sandbox_profile_failed', new Error('Sandbox profile probe returned no usable profile.'), { stage: 'sandbox profile' }, true);
    return profile;
  } catch (error) {
    state.timedOut = true;
    logError('sandbox_profile_failed', error, { stage: 'sandbox profile' }, true);
    return undefined;
  } finally {
    await state.session?.close().catch(() => undefined);
  }
}

/** The fixed system prompt paragraph for the sandbox. The same profile always gives the same text. */
export function sandboxPromptText(profile: SandboxProfile): string {
  const installed = [...new Set(profile.installed)].sort();
  const list = installed.length ? installed.join(', ') : 'none of the common tools';
  return `Sandbox for read, write, edit and shell: ${profile.os}, user ${profile.user}, home ${profile.home}. Uploaded files are in ${profile.home}/uploads. Installed: ${list}. No sudo. A sandbox expires ${SANDBOX_LIFETIME_MS / 60000} minutes after its last use.`;
}

/** The prompt paragraph when a profile is known, otherwise undefined: no line is added. */
export function sandboxPromptLine(profile: SandboxProfile | undefined): string | undefined {
  return profile ? sandboxPromptText(profile) : undefined;
}
