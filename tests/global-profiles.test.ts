import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { GlobalProfiles } from '../src/global-profiles.js';
import { registerProfileTools } from '../src/profiles.js';
import { ToolRegistry } from '../src/tools.js';
import { Application } from '../src/application.js';
import type { Json, Message } from '../src/domain.js';

const owner = '474858037970993152', other = '474858037970993153';
const message = (server: string, id: string, author = owner): Message => ({ server, id, channel: 'channel', author, authorName: author === owner ? 'Owner' : 'Other', text: 'Explicit profile request', addressed: true });
function registry(store: SQLiteStore, admin: boolean) {
  const tools = new ToolRegistry(store, async () => admin); registerProfileTools(tools, store); return tools;
}

test('global profile fields follow the account across servers and persist across restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'slopbot-global-profile-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.sqlite'); let store = new SQLiteStore(path); t.after(() => store.close());
  const a = message('server-a', 'source-a'), b = message('server-b', 'source-b'); await store.ingest(a); await store.ingest(b);
  await registry(store, false).invoke(a, 'profile', { scope: 'global', action: 'set', field: 'github', value: 'https://github.com/owner' }, 'global-set', 'command');
  const result = await registry(store, false).invoke(b, 'profile', { scope: 'global', action: 'get' }, 'global-read-b', 'command');
  assert.match(result, /https:\/\/github.com\/owner/); assert.match(result, /Only the owner/);
  assert.equal(store.profile('server-a', owner).fields.length, 0); assert.equal(store.profile('server-b', owner).fields.length, 0);
  await store.remove(a.server, a.channel, a.id);
  store.close(); store = new SQLiteStore(path);
  const profile = await new GlobalProfiles(store).get(owner);
  assert.equal(profile.allowEdits, false); assert.deepEqual(profile.fields[0]?.sourceIds, []);
  assert.equal(profile.fields[0]?.value, 'https://github.com/owner');
});

test('other users and server admins cannot edit, remove, unlock, undo or read global edit history', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); const profiles = new GlobalProfiles(store);
  const a = message('server-a', 'owner'), b = message('server-b', 'admin', other); await store.ingest(a); await store.ingest(b);
  await profiles.edit(owner, owner, 'github', 'owner-value', 'first');
  const admin = registry(store, true);
  for (const args of [
    { action: 'set', field: 'github', value: 'attacker' }, { action: 'remove', field: 'github' },
    { action: 'lock', allow_edits: false }, { action: 'history' }, { action: 'undo', revision: 'first' },
  ]) await assert.rejects(admin.invoke(b, 'profile', { scope: 'global', user: owner, ...args } as Record<string, Json>, `denied-${args.action}`, 'command'), /Only the profile owner/);
  await assert.rejects(admin.invoke(a, 'profile', { scope: 'global', action: 'lock', allow_edits: true }, 'unlock', 'command'), /always owner-only/);
  const read = await admin.invoke(b, 'profile', { scope: 'global', user: owner }, 'public-read', 'command'); assert.match(read, /owner-value/);
  assert.equal((await profiles.get(owner)).fields[0]?.value, 'owner-value');
});

test('global history, undo and concurrent edits preserve ownership and avoid lost updates', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); const profiles = new GlobalProfiles(store);
  await profiles.edit(owner, owner, 'nickname', 'first', 'v1'); await profiles.edit(owner, owner, 'nickname', 'second', 'v2');
  await assert.rejects(profiles.undo(owner, owner, 'v1', 'stale-undo'), /newer global edit/);
  await profiles.undo(owner, owner, 'v2', 'undo-v2'); assert.equal((await profiles.get(owner)).fields[0]?.value, 'first');
  assert.equal((await profiles.history(owner, owner))[0]?.revision, 'undo-v2');
  const results = await Promise.allSettled([new GlobalProfiles(store).edit(owner, owner, 'one', 'a', 'concurrent-one'), new GlobalProfiles(store).edit(owner, owner, 'two', 'b', 'concurrent-two')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await profiles.get(owner)).fields.length, 2);
});

test('model context uses global owner facts over conflicting server fields without importing source identity', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); const profiles = new GlobalProfiles(store);
  const request = message('server-b', 'context'); await store.ingest(request);
  store.editProfile(request, owner, 'github', 'server-repo', 'server-value');
  await profiles.edit(owner, owner, 'github', 'global-owner-repo', 'global-value');
  let input = '';
  const app = new Application(store, { async *stream(prompt) { input = prompt.inputs.map(item => item.content).join('\n'); yield { kind: 'text', payload: { text: 'Done' } }; } }, { allowedChannels: [{ server: request.server, channel: request.channel }] }, undefined, { profiles: store });
  await app.handle(request, true);
  assert.match(input, /global-owner-repo/); assert.match(input, /global, owner-supplied/); assert.ok(!input.includes('server-repo'));
});

test('a retained revision can undo safely when its prior revision aged out of history', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); const profiles = new GlobalProfiles(store);
  await profiles.edit(owner, owner, 'github', 'original', 'original');
  for (let i = 0; i < 201; i++) await profiles.edit(owner, owner, 'counter', i, `counter-${i}`);
  await profiles.edit(owner, owner, 'github', 'replacement', 'replacement');
  await profiles.undo(owner, owner, 'replacement', 'undo-replacement');
  const profile = await profiles.get(owner);
  assert.equal(profile.fields.find(field => field.field === 'github')?.value, 'original');
  assert.equal('previous' in profile.fields[0]!, false);
});
