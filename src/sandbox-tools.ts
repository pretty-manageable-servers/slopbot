import type { Message } from './domain.js';
import type { RecordStore } from './records.js';
import { requestTimings } from './request-timing.js';
import type { SandboxProvider, SandboxSession } from './sandbox.js';
import { SANDBOX_HOME, sandboxSession } from './sandbox-session.js';
import { ToolError, UncertainActionError, type ToolArgs, type ToolContext, type ToolDefinition } from './tools.js';

const readCharacters = 16000;
const outputCharacters = 16000;
const readLineLimit = 2000;
const writeCharacters = 64000;
const commandCharacters = 16000;
const pathCharacters = 1024;
const replacedNotice = 'New sandbox started; earlier files are gone.';
const mkdirSeconds = 30;

/** Quotes one value for the POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Relative paths resolve under the sandbox home. */
export function sandboxPath(path: string): string {
  return path.startsWith('/') ? path : `${SANDBOX_HOME}/${path}`;
}

function cut(text: string): string {
  return text.length > outputCharacters ? `${text.slice(0, outputCharacters)}\n[Output truncated.]` : text;
}

function sandboxResource(message: Message): string {
  return `sandbox:${message.server}:${message.channel}`;
}

function checkPath(args: ToolArgs): void {
  if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > pathCharacters || args.path.includes('\0')) throw new ToolError(`path must be a file path of 1-${pathCharacters} characters.`);
}

/** Gets the task sandbox. Starts one when none is active. A replaced sandbox (expired or not connectable) adds a notice to the result. */
async function workspace(store: RecordStore, provider: SandboxProvider | undefined, context: ToolContext): Promise<{ session: SandboxSession; notice: string }> {
  if (!provider) throw new ToolError('Sandbox is not configured. Set E2B_API_KEY to a PMServers project token.');
  await context.assertActive();
  const { message } = context;
  const before = await store.record(message.server, 'sandbox', message.channel);
  const hadSession = Boolean((before?.value as { id?: string } | undefined)?.id);
  const { session, created } = await sandboxSession(store, provider, message, context.operationId);
  await context.assertActive();
  return { session, notice: created && hadSession ? `${replacedNotice}\n` : '' };
}

function readTool(store: RecordStore, provider?: SandboxProvider): ToolDefinition {
  return {
    name: 'read',
    surface: 'top',
    description: 'Read a text file in the sandbox. Returns numbered lines, at most 16000 characters. Relative paths start in /home/user. Use offset and limit to read long files in parts.',
    fields: {
      path: { type: 'string', required: true, max: pathCharacters, description: 'File path. Absolute, or relative to /home/user.' },
      offset: { type: 'integer', min: 1, description: 'First line to return, counted from 1. Default 1.' },
      limit: { type: 'integer', min: 1, max: readLineLimit, description: `Number of lines to return, at most ${readLineLimit}. Default ${readLineLimit}.` },
    },
    access: 'member', effect: 'read', execution: 'inline', retrySafe: false,
    resource: sandboxResource,
    validate(args) { checkPath(args); return args; },
    async execute(context, args) {
      const { session, notice } = await workspace(store, provider, context);
      const path = sandboxPath(String(args.path));
      const text = await requestTimings.wait('sandbox read', () => session.read(path));
      if (text === '') return `${notice}The file is empty.`;
      const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
      const start = Number(args.offset ?? 1);
      const count = Number(args.limit ?? readLineLimit);
      if (start > lines.length) return `${notice}The file has ${lines.length} lines. Offset ${start} is past the end.`;
      const out: string[] = [];
      let size = 0, line = start;
      for (; line <= lines.length && out.length < count; line++) {
        const entry = `${line}\t${lines[line - 1]}`.slice(0, readCharacters);
        if (out.length && size + entry.length + 1 > readCharacters) break;
        out.push(entry);
        size += entry.length + 1;
      }
      let body = out.join('\n');
      if (line <= lines.length) body += `\n[Showing lines ${start}-${line - 1} of ${lines.length}. Use offset ${line} to read more.]`;
      return `${notice}${body}`;
    },
  };
}

function writeTool(store: RecordStore, provider?: SandboxProvider): ToolDefinition {
  return {
    name: 'write',
    surface: 'top',
    description: 'Create or replace a text file in the sandbox. Creates parent directories. Relative paths start in /home/user. Content is at most 64000 characters.',
    fields: {
      path: { type: 'string', required: true, max: pathCharacters, description: 'File path. Absolute, or relative to /home/user.' },
      content: { type: 'string', required: true, max: writeCharacters, description: 'Full UTF-8 text of the file.' },
    },
    access: 'member', effect: 'write', execution: 'inline', retrySafe: false,
    resource: sandboxResource,
    validate(args) {
      checkPath(args);
      if (typeof args.content !== 'string' || args.content.length > writeCharacters) throw new ToolError(`content must be text of at most ${writeCharacters} characters.`);
      return args;
    },
    async execute(context, args) {
      const { session, notice } = await workspace(store, provider, context);
      const path = sandboxPath(String(args.path));
      const dir = path.slice(0, path.lastIndexOf('/')) || '/';
      const made = await requestTimings.wait('sandbox mkdir', () => session.run(`mkdir -p ${shellQuote(dir)}`, mkdirSeconds * 1000));
      if (made.exitCode !== 0) throw new ToolError(`Could not create ${dir}: ${made.stderr.trim() || 'mkdir failed'}`);
      await requestTimings.wait('sandbox write', () => session.write(path, String(args.content)));
      return `${notice}Wrote ${path}.`;
    },
  };
}

function editTool(store: RecordStore, provider?: SandboxProvider): ToolDefinition {
  return {
    name: 'edit',
    surface: 'top',
    description: 'Replace text in a sandbox file. old_string must match the file exactly and occur once, unless replace_all is true. Relative paths start in /home/user.',
    fields: {
      path: { type: 'string', required: true, max: pathCharacters, description: 'File path. Absolute, or relative to /home/user.' },
      old_string: { type: 'string', required: true, description: 'Exact text to replace. Include enough context to make it unique.' },
      new_string: { type: 'string', required: true, description: 'Text that replaces old_string. May be empty.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string. Default false.' },
    },
    access: 'member', effect: 'write', execution: 'inline', retrySafe: false,
    resource: sandboxResource,
    validate(args) {
      checkPath(args);
      if (typeof args.old_string !== 'string' || args.old_string === '') throw new ToolError('old_string must be non-empty text.');
      if (typeof args.new_string !== 'string') throw new ToolError('new_string must be text.');
      return args;
    },
    async execute(context, args) {
      const { session, notice } = await workspace(store, provider, context);
      const path = sandboxPath(String(args.path));
      const oldText = String(args.old_string), newText = String(args.new_string);
      const text = await requestTimings.wait('sandbox read', () => session.read(path));
      const found = text.split(oldText).length - 1;
      if (found === 0) throw new ToolError(`old_string was not found in ${path}. It must match the file text exactly, including spaces and line breaks. Found 0 matches.`);
      const all = args.replace_all === true;
      if (found > 1 && !all) throw new ToolError(`old_string occurs ${found} times in ${path}. Add more surrounding text to make it unique, or set replace_all to true. Found ${found} matches.`);
      const updated = all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
      await requestTimings.wait('sandbox write', () => session.write(path, updated));
      return `${notice}Edited ${path}: ${all ? found : 1} of ${found} matches replaced.`;
    },
  };
}

function shellTool(store: RecordStore, provider?: SandboxProvider): ToolDefinition {
  return {
    name: 'shell',
    surface: 'top',
    description: 'Run a shell command in the sandbox. Returns the exit code, stdout and stderr, each at most 16000 characters. Runs as user in /home/user. Files from earlier calls stay in the sandbox.',
    fields: {
      command: { type: 'string', required: true, max: commandCharacters, description: 'Shell command to run in the sandbox.' },
      timeout_seconds: { type: 'integer', min: 1, max: 120, description: 'Time limit in seconds. Default 30.' },
    },
    access: 'member', effect: 'write', execution: 'inline', retrySafe: false,
    resource: sandboxResource,
    validate(args) {
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > commandCharacters) throw new ToolError(`command must be text of 1-${commandCharacters} characters.`);
      return args;
    },
    async execute(context, args) {
      const { session, notice } = await workspace(store, provider, context);
      const seconds = Number(args.timeout_seconds ?? 30);
      let output;
      try { output = await requestTimings.wait('sandbox command', () => session.run(String(args.command), seconds * 1000)); }
      catch (error) {
        // The provider reports a timeout, or a lost result, as UncertainActionError. The model gets a normal result instead.
        if (error instanceof UncertainActionError) return `${notice}Exit code: 124 (timed out after ${seconds} s). The command may still run in the sandbox.`;
        throw error;
      }
      return `${notice}Exit code: ${output.exitCode}\nstdout:\n${cut(output.stdout)}\nstderr:\n${cut(output.stderr)}`;
    },
  };
}

/** The four file and command tools of the sandbox. They are top-level tools. Registration is done elsewhere. */
export function sandboxFileTools(store: RecordStore, provider?: SandboxProvider): ToolDefinition[] {
  return [readTool(store, provider), writeTool(store, provider), editTool(store, provider), shellTool(store, provider)];
}
