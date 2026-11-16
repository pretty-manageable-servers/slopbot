import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROJECT_LIMITS, PROJECT_ID, PROJECT_MEMORY_SERVER, hasProjectStore, memoryScope, newProjectId, projectBlock, projectFileKey, projectLimits, type Project, type ProjectFile } from '../src/projects.js';

const project: Project = { id: 'a'.repeat(32), owner: 'ana', name: 'Thesis', description: '', instructions: '', instructionsUpdated: null, created: 1, updated: 1 };
const file: ProjectFile = { id: 'b'.repeat(32) + '.pdf', project: project.id, name: 'paper.pdf', contentType: 'application/pdf', size: 2 * 1024 * 1024, created: 1 };

test('projectLimits defaults bad fields and clamps integers', () => {
  assert.deepEqual(projectLimits(undefined), DEFAULT_PROJECT_LIMITS);
  assert.deepEqual(projectLimits({ maxFiles: '9', maxProjects: 1.5 }), DEFAULT_PROJECT_LIMITS);
  assert.deepEqual(projectLimits({ maxProjects: 0, maxFiles: 9999, maxFileBytes: 1, maxProjectBytes: 5 * 1024 ** 3 }), { maxProjects: 1, maxFiles: 500, maxFileBytes: 1024, maxProjectBytes: 2 * 1024 ** 3 });
});

test('memoryScope uses the project scope only in project chats', () => {
  assert.deepEqual(memoryScope({ server: 's1', channel: 'web:c1' }), { server: 's1', channel: 'web:c1' });
  assert.deepEqual(memoryScope({ server: 's1', channel: 'web:c1', project: project.id }), { server: PROJECT_MEMORY_SERVER, channel: `project:${project.id}` });
});

test('ids, keys and store guard', () => {
  assert.match(newProjectId(), PROJECT_ID);
  assert.equal(projectFileKey(project.id, file.id), `project-files/${project.id}/${file.id}`);
  assert.equal(hasProjectStore({}), false);
});

test('projectBlock with instructions and files, and with neither', () => {
  const full = projectBlock({ ...project, instructions: 'Use APA 7.' }, [file]);
  assert.match(full, /^<project-instructions>\nUse APA 7\.\n<\/project-instructions>\n/);
  assert.match(full, /project instructions win/);
  assert.match(full, /- paper\.pdf \(application\/pdf, 2\.0 MB\)/);
  const empty = projectBlock(project, []);
  assert.doesNotMatch(empty, /project-instructions/);
  assert.equal(empty, 'Project "Thesis" has no files.\n');
});
