import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import type { Message } from '../src/domain.js';
import { projectFileKey, type Project, type ProjectFile } from '../src/projects.js';
import { syncProjectToSandbox } from '../src/project-sandbox.js';
import { SANDBOX_HOME } from '../src/sandbox-session.js';
import type { SandboxProvider, SandboxSession } from '../src/sandbox.js';

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
  const written = new Map<string, Uint8Array>();
  const session: SandboxSession = {
    id: 'workspace',
    async run(command) {
      // The fake sandbox only models the rm -rf of the copy directory, which is what a stale copy needs.
      if (command.startsWith('rm -rf ')) for (const path of [...written.keys()]) if (path.startsWith(command.slice(7).split(' ')[0] + '/')) written.delete(path);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async write(path, data) { written.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data); },
    async read(path) { const bytes = written.get(path); if (!bytes) throw new Error(`missing ${path}`); return new TextDecoder().decode(bytes); },
    async readBytes() { return new Uint8Array(); }, async renew() {}, async close() {},
  };
  const provider: SandboxProvider = { defaultTemplate: 'base', async create() { return session; }, async connect() { return session; } };
  const deps = {
    store, provider,
    projects: {
      async project(id: string) { return id === project.id ? project : undefined; },
      async projectFiles(id: string) { return files.filter(file => file.project === id); },
    },
    storage: { async get(key: string) { const bytes = objects.get(key); if (!bytes) throw new Error(`missing ${key}`); return bytes; } },
  };
  return {
    deps, project, written, objects,
    setFiles(next: ProjectFile[]) { files = next; },
    text(path: string) { const bytes = written.get(path); return bytes && new TextDecoder().decode(bytes); },
    close: () => store.close(),
  };
}

test('sync copies the project files and writes the revision marker', async t => {
  const f = fixture(); t.after(f.close);
  await syncProjectToSandbox(f.deps, message);
  assert.equal(f.text(`${dir}/notes.md`), 'hello');
  assert.equal(f.text(`${dir}/data.csv`), 'a,b');
  assert.equal(f.text(marker), String(f.project.updated));
});

test('sync does nothing when the copy already has the project revision', async t => {
  const f = fixture(); t.after(f.close);
  await syncProjectToSandbox(f.deps, message);
  f.objects.set(projectFileKey(f.project.id, 'f1'), new TextEncoder().encode('changed without a new revision'));
  await syncProjectToSandbox(f.deps, message);
  assert.equal(f.text(`${dir}/notes.md`), 'hello');
});

test('sync copies again after the project changed, and drops files that were deleted', async t => {
  const f = fixture(); t.after(f.close);
  await syncProjectToSandbox(f.deps, message);
  f.project.updated = 4;
  f.objects.set(projectFileKey(f.project.id, 'f1'), new TextEncoder().encode('v2'));
  f.setFiles([{ id: 'f1', project: f.project.id, name: 'notes.md', contentType: 'text/markdown', size: 2, created: 1 }]);
  await syncProjectToSandbox(f.deps, message);
  assert.equal(f.text(`${dir}/notes.md`), 'v2');
  assert.equal(f.text(`${dir}/data.csv`), undefined);
  assert.equal(f.text(marker), '4');
});

test('sync copies nothing for no project, another person\'s project, or without deps', async t => {
  const f = fixture(); t.after(f.close);
  await syncProjectToSandbox(f.deps, noProject);
  await syncProjectToSandbox(f.deps, { ...message, author: 'someone-else' });
  await syncProjectToSandbox(undefined, message);
  assert.equal(f.written.size, 0);
});

test('a failed copy is not thrown, and leaves no marker so the next run copies again', async t => {
  const f = fixture(); t.after(f.close);
  f.objects.delete(projectFileKey(f.project.id, 'f2'));
  await assert.doesNotReject(syncProjectToSandbox(f.deps, message));
  assert.equal(f.text(marker), undefined);
});
