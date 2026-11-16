import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../src/domain.js';
import { projectFilesTool } from '../src/project-files-tool.js';
import { projectFileKey, type Project, type ProjectFile } from '../src/projects.js';
import { ToolError, toolResult, type ToolContext } from '../src/tools.js';

const project: Project = { id: 'project-1', owner: 'person', name: 'Research', description: '', instructions: '', instructionsUpdated: null, created: 1, updated: 1 };
const message: Message = { id: 'request', server: 's', channel: 'chat', author: 'person', text: 'What is in the project?', addressed: true, project: project.id };
const { project: _project, ...noProject } = message;

function file(id: string, name: string, contentType: string, size: number, projectId = project.id): ProjectFile {
  return { id, project: projectId, name, contentType, size, created: 1 };
}

function fixture(stored: { file: ProjectFile; bytes: Uint8Array }[]) {
  const objects = new Map(stored.map(item => [projectFileKey(item.file.project, item.file.id), item.bytes]));
  const inspected: { name: string; size: number; question: string }[] = [];
  const tool = projectFilesTool({
    projects: {
      async project(id) { return id === project.id ? project : undefined; },
      async projectFiles(id) { return stored.map(item => item.file).filter(item => item.project === id).sort((a, b) => a.name.localeCompare(b.name)); },
    },
    storage: { async get(key) { const bytes = objects.get(key); if (!bytes) throw new Error(`missing ${key}`); return bytes; } },
    async inspect(_context, item, bytes, question) { inspected.push({ name: item.name, size: bytes.length, question }); return `answer about ${item.name}`; },
  });
  const run = async (args: Record<string, string | number>, from: Message = message) => {
    const context = { message: from, operationId: 'operation', isAdmin: false, source: 'agent', toolName: 'project_files', arguments: args, resource: null, assertActive: async () => undefined } as ToolContext;
    return toolResult(await tool.execute(context, args)).text;
  };
  return { run, inspected };
}

const encode = (text: string) => new TextEncoder().encode(text);

test('list gives one line per project file with its name, type and size', async () => {
  const { run } = fixture([
    { file: file('f1', 'notes.md', 'text/markdown', 120), bytes: encode('# Notes') },
    { file: file('f2', 'scan.pdf', 'application/pdf', 2048), bytes: encode('%PDF') },
  ]);
  assert.equal(await run({ action: 'list' }), 'notes.md (text/markdown, 120 B)\nscan.pdf (application/pdf, 2.0 KB)');
});

test('reads a long text file in pieces, with a more line until the end', async () => {
  const text = 'x'.repeat(16000) + 'END';
  const { run } = fixture([{ file: file('f1', 'long.txt', 'text/plain', text.length), bytes: encode(text) }]);
  assert.equal(await run({ action: 'read', file: 'long.txt' }), 'x'.repeat(16000) + '\n[more from offset 16000]');
  assert.equal(await run({ action: 'read', file: 'long.txt', offset: 16000 }), 'END');
});

test('finds a file by id, by exact name, or by name ignoring case', async () => {
  const { run } = fixture([{ file: file('f1', 'Data.csv', 'text/csv', 4), bytes: encode('a,b\n') }]);
  assert.equal(await run({ action: 'read', file: 'f1' }), 'a,b\n');
  assert.equal(await run({ action: 'read', file: 'Data.csv' }), 'a,b\n');
  assert.equal(await run({ action: 'read', file: 'data.CSV' }), 'a,b\n');
});

test('reads a binary file by calling inspect with its bytes and the question', async () => {
  const { run, inspected } = fixture([{ file: file('f1', 'scan.pdf', 'application/pdf', 3), bytes: new Uint8Array([1, 2, 3]) }]);
  assert.equal(await run({ action: 'read', file: 'scan.pdf', question: 'What is the total?' }), 'answer about scan.pdf');
  assert.deepEqual(inspected, [{ name: 'scan.pdf', size: 3, question: 'What is the total?' }]);
});

test('reading a binary file without a question fails', async () => {
  const { run, inspected } = fixture([{ file: file('f1', 'scan.pdf', 'application/pdf', 3), bytes: new Uint8Array([1, 2, 3]) }]);
  await assert.rejects(run({ action: 'read', file: 'scan.pdf' }), ToolError);
  assert.deepEqual(inspected, []);
});

test('a file of another project cannot be read by id', async () => {
  const { run } = fixture([
    { file: file('mine', 'notes.md', 'text/markdown', 5), bytes: encode('mine!') },
    { file: file('theirs', 'secret.md', 'text/markdown', 5, 'project-2'), bytes: encode('secret') },
  ]);
  await assert.rejects(run({ action: 'read', file: 'theirs' }), ToolError);
});

test('a chat that is not in a project, or in another person\'s project, gets an error', async () => {
  const { run } = fixture([{ file: file('f1', 'notes.md', 'text/markdown', 5), bytes: encode('notes') }]);
  await assert.rejects(run({ action: 'list' }, noProject), ToolError);
  await assert.rejects(run({ action: 'list' }, { ...message, author: 'someone-else' }), ToolError);
  await assert.rejects(run({ action: 'list' }, { ...message, project: 'missing-project' }), ToolError);
});
