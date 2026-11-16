import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { PostgresStore } from '../src/adapters/postgres.js';
import type { Project, ProjectFile, ProjectStore } from '../src/projects.js';

const schema = 'slopbot_test_project_store';
const url = process.env.TEST_DATABASE_URL;
const hex = (n: number) => n.toString(16).padStart(32, '0');
const project = (n: number, owner = 'alice', updated = 1000): Project => ({ id: hex(n), owner, name: `Notes ${n}`, description: 'Research', instructions: 'Be terse', instructionsUpdated: null, created: 1000, updated });
const file = (project: string, n: number, name: string, created: number): ProjectFile => ({ id: hex(n), project, name, contentType: 'text/plain', size: 12, created });

for (const backend of ['sqlite', 'postgres'] as const) {
  const skip = backend === 'postgres' && !url;
  const inStore = (name: string, body: (store: ProjectStore) => Promise<void>) => test(`${backend}: ${name}`, { skip }, async t => {
    const store = backend === 'sqlite' ? new SQLiteStore() : await PostgresStore.connect(url!, undefined, schema);
    t.after(async () => {
      await store.close();
      if (backend === 'postgres') { const cleanup = new Client({ connectionString: url }); await cleanup.connect(); await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); await cleanup.end(); }
    });
    await body(store);
  });

  inStore('creates a project and reads it back', async store => {
    const created = { ...project(1), instructionsUpdated: 1000 };
    await store.createProject(created);
    assert.deepEqual(await store.project(created.id), created);
    assert.equal(await store.project(hex(2)), undefined);
  });

  inStore('lists the owner\'s projects newest updated first, then id', async store => {
    await store.createProject(project(2, 'alice', 1000));
    await store.createProject(project(3, 'alice', 2000));
    await store.createProject(project(1, 'alice', 2000));
    await store.createProject(project(4, 'bob', 3000));
    assert.deepEqual((await store.projectsOf('alice')).map(item => item.id), [hex(1), hex(3), hex(2)]);
    assert.deepEqual(await store.projectsOf('carol'), []);
  });

  inStore('updates the given fields and sets updated', async store => {
    await store.createProject(project(1));
    await store.updateProject(hex(1), { name: 'Renamed', instructions: 'Be kind', instructionsUpdated: 2000 }, 2000);
    assert.deepEqual(await store.project(hex(1)), { ...project(1), name: 'Renamed', instructions: 'Be kind', instructionsUpdated: 2000, updated: 2000 });
    await store.updateProject(hex(1), { description: 'Work' }, 3000);
    assert.deepEqual(await store.project(hex(1)), { ...project(1), name: 'Renamed', description: 'Work', instructions: 'Be kind', instructionsUpdated: 2000, updated: 3000 });
  });

  inStore('a deleted project is hidden and its files are gone', async store => {
    await store.createProject(project(1));
    await store.createProject(project(2));
    await store.addProjectFile(file(hex(1), 1, 'a.txt', 1500));
    await store.deleteProject(hex(1), 3000);
    assert.equal(await store.project(hex(1)), undefined);
    assert.deepEqual((await store.projectsOf('alice')).map(item => item.id), [hex(2)]);
    assert.deepEqual(await store.projectFiles(hex(1)), []);
  });

  inStore('adds, lists and deletes files and sets the project updated time', async store => {
    await store.createProject(project(1));
    await store.addProjectFile(file(hex(1), 2, 'b.txt', 2000));
    await store.addProjectFile(file(hex(1), 3, 'a.txt', 3000));
    await store.addProjectFile(file(hex(1), 1, 'a.txt', 3000));
    assert.deepEqual((await store.projectFiles(hex(1))).map(item => item.id), [hex(1), hex(3), hex(2)]);
    assert.equal((await store.project(hex(1)))?.updated, 3000);
    assert.equal(await store.deleteProjectFile(hex(1), hex(3), 4000), true);
    assert.deepEqual((await store.projectFiles(hex(1))).map(item => item.id), [hex(1), hex(2)]);
    assert.equal((await store.project(hex(1)))?.updated, 4000);
  });

  inStore('deleteProjectFile returns false for a missing file and leaves updated alone', async store => {
    await store.createProject(project(1));
    assert.equal(await store.deleteProjectFile(hex(1), hex(9), 2000), false);
    assert.equal((await store.project(hex(1)))?.updated, 1000);
  });
}
