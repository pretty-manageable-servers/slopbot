import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import type { Message } from '../src/domain.js';
import { projectFilesTool } from '../src/project-files-tool.js';
import { projectSandboxOpenHook } from '../src/project-sandbox.js';
import { projectFileKey, type Project, type ProjectFile } from '../src/projects.js';
import { onSandboxOpen, sandboxSession, SANDBOX_HOME } from '../src/sandbox-session.js';
import type { SandboxProvider, SandboxSession } from '../src/sandbox.js';
import { ToolError, toolResult, type ToolContext } from '../src/tools.js';

const dir = `${SANDBOX_HOME}/project`;
const marker = `${dir}/.slopbot-rev`;
const message: Message = { id: 'request', server: 's', channel: 'chat', author: 'person', text: 'Use the project', addressed: true, project: 'project-1' };
const { project: _project, ...noProject } = message;

function fixture() {
  const store = new SQLiteStore();
  const project: Project = { id: 'project-1', owner: 'person', name: 'Research', description: '', instructions: '', instructionsUpdated: null, created: 1, updated: 3 };
  let files: ProjectFile[] = [
    { id: 'f1', project: project.id, name: 'notes.md', contentType: 'text/markdown', size: 5, created: 1 },
    { id: 'f2', project: project.id, name: 'data.csv', contentType: 'text/csv', size: 3, created: 1 },
  ];
  const objects = new Map<string, Uint8Array>([
    [projectFileKey(project.id, 'f1'), new TextEncoder().encode('hello')],
    [projectFileKey(project.id, 'f2'), new TextEncoder().encode('a,b')],
  ]);
  const failures = new Map<string, Error>();
  const written = new Map<string, Uint8Array>();
  const commands: string[] = [];
  let opened = false;
  const session: SandboxSession = {
    id: 'workspace',
    async run(command) {
      commands.push(command);
      // The fake sandbox only models the rm -rf of the copy directory, which is what a stale copy needs.
      if (command.startsWith('rm -rf ')) for (const path of [...written.keys()]) if (path.startsWith(command.slice(7).split(' ')[0] + '/')) written.delete(path);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async write(path, data) { written.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data); },
    async read(path) { const bytes = written.get(path); if (!bytes) throw new Error(`missing ${path}`); return new TextDecoder().decode(bytes); },
    async readBytes() { return new Uint8Array(); }, async renew() {}, async close() {},
  };
  const provider: SandboxProvider = { defaultTemplate: 'base', async create() { opened = true; return session; }, async connect() { return session; } };
  const storage = {
    async get(key: string) {
      const failure = failures.get(key);
      if (failure) throw failure;
      const bytes = objects.get(key);
      // The same shape as the S3 provider: a ToolError whose cause is the NoSuchKey error.
      if (!bytes) throw new ToolError('Stored object is missing.', 'failed', { cause: Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' }) });
      return bytes;
    },
  };
  const projects = {
    async project(id: string) { return id === project.id ? project : undefined; },
    async projectFiles(id: string) { return files.filter(file => file.project === id); },
  };
  // The engine registers the hook once per store; sandboxSession runs it when a run opens its sandbox.
  onSandboxOpen(store, projectSandboxOpenHook({ projects, storage }));
  return {
    project, written, objects, failures, projects, storage, commands,
    opened: () => opened,
    open: (from: Message = message) => sandboxSession(store, provider, from, 'run'),
    setFiles(next: ProjectFile[]) { files = next; },
    text(path: string) { const bytes = written.get(path); return bytes && new TextDecoder().decode(bytes); },
    close: () => store.close(),
  };
}

function callProjectFiles(f: ReturnType<typeof fixture>, args: Record<string, string>) {
  const tool = projectFilesTool({ projects: f.projects, storage: f.storage, inspect: async () => '' });
  const context = { message, operationId: 'operation', isAdmin: false, source: 'agent', toolName: 'project_files', arguments: args, resource: null, assertActive: async () => undefined } as ToolContext;
  return tool.execute(context, args).then(toolResult);
}

test('a sandbox opened for a project chat gets the project files and the marker', async t => {
  const f = fixture(); t.after(f.close);
  await f.open();
  assert.equal(f.text(`${dir}/notes.md`), 'hello');
  assert.equal(f.text(`${dir}/data.csv`), 'a,b');
  assert.equal(f.text(marker), String(f.project.updated));
});

test('a run that only reads project files opens no sandbox and copies nothing', async t => {
  const f = fixture(); t.after(f.close);
  const listed = await callProjectFiles(f, { action: 'list' });
  assert.match(listed.text, /notes\.md/);
  assert.equal(f.opened(), false);
  assert.equal(f.written.size, 0);
  // The copy comes with the first sandbox the run opens.
  await f.open();
  assert.equal(f.text(`${dir}/notes.md`), 'hello');
});

test('a sandbox opened for a chat that is not the owner\'s project copies nothing', async t => {
  const f = fixture(); t.after(f.close);
  await f.open({ ...message, author: 'someone-else' });
  await f.open(noProject);
  assert.equal(f.written.size, 0);
});

test('an open skips the copy while the copy has the project revision', async t => {
  const f = fixture(); t.after(f.close);
  await f.open();
  f.objects.set(projectFileKey(f.project.id, 'f1'), new TextEncoder().encode('changed without a new revision'));
  await f.open();
  assert.equal(f.text(`${dir}/notes.md`), 'hello');
});

test('an open copies again after the project changed, and drops files that were deleted', async t => {
  const f = fixture(); t.after(f.close);
  await f.open();
  f.project.updated = 4;
  f.objects.set(projectFileKey(f.project.id, 'f1'), new TextEncoder().encode('v2'));
  f.setFiles([{ id: 'f1', project: f.project.id, name: 'notes.md', contentType: 'text/markdown', size: 2, created: 1 }]);
  await f.open();
  assert.equal(f.text(`${dir}/notes.md`), 'v2');
  assert.equal(f.text(`${dir}/data.csv`), undefined);
  assert.equal(f.text(marker), '4');
});

test('a file whose object is missing is skipped, and the marker is still written', async t => {
  const f = fixture(); t.after(f.close);
  f.objects.delete(projectFileKey(f.project.id, 'f2'));
  await f.open();
  assert.equal(f.text(`${dir}/notes.md`), 'hello');
  assert.equal(f.text(`${dir}/data.csv`), undefined);
  assert.equal(f.text(marker), String(f.project.updated));
});

test('another storage failure is not thrown, leaves no marker, and the next run copies again', async t => {
  const f = fixture(); t.after(f.close);
  const key = projectFileKey(f.project.id, 'f2');
  f.failures.set(key, new Error('connection reset'));
  await assert.doesNotReject(f.open());
  assert.equal(f.text(`${dir}/notes.md`), 'hello');
  assert.equal(f.text(marker), undefined);
  f.failures.delete(key);
  await f.open();
  assert.equal(f.text(`${dir}/data.csv`), 'a,b');
  assert.equal(f.text(marker), String(f.project.updated));
});

test('parallel sandbox calls in one run copy the project once', async t => {
  const f = fixture(); t.after(f.close);
  await Promise.all([f.open(), f.open(), f.open()]);
  assert.equal(f.text(`${dir}/notes.md`), 'hello');
  assert.equal(f.text(marker), String(f.project.updated));
  assert.equal(f.commands.filter(command => command.startsWith('rm -rf ')).length, 1);
});
