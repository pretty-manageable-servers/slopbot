import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { Application } from '../src/application.js';
import { parseSandboxProfile, probeSandboxProfile, sandboxPromptLine, sandboxPromptText, type SandboxProfile } from '../src/sandbox-profile.js';
import type { SandboxProvider, SandboxSession } from '../src/sandbox.js';

const profile: SandboxProfile = { template: 'base', user: 'ubuntu', home: '/home/ubuntu', os: 'Ubuntu 24.04.1 LTS', installed: ['python3', 'node', 'git'] };

test('prompt_text_deterministic: the same profile always gives the same sorted text', () => {
  const text = 'Sandbox for read, write, edit and shell: Ubuntu 24.04.1 LTS, user ubuntu, home /home/ubuntu. Uploaded files are in /home/ubuntu/uploads. Installed: git, node, python3. No sudo. A sandbox expires 10 minutes after its last use.';
  assert.equal(sandboxPromptText(profile), text);
  assert.equal(sandboxPromptText({ ...profile, installed: ['git', 'python3', 'node', 'git'] }), text);
  assert.equal(sandboxPromptText({ ...profile, installed: [] }), text.replace('git, node, python3', 'none of the common tools'));
});

test('probe_reads_profile: one sandbox is started, read and closed', async () => {
  const log: string[] = [];
  const session: SandboxSession = {
    id: 'probe', async run(command) { log.push(`run:${command.split(';')[0]}`); return { stdout: 'user=ubuntu\nhome=/home/ubuntu\nos=Ubuntu 24.04.1 LTS\ntool=python3\ntool=git\n', stderr: '', exitCode: 0 }; },
    async read() { return ''; }, async readBytes() { return new Uint8Array(); }, async write() {}, async renew() {}, async close() { log.push('close'); },
  };
  const provider: SandboxProvider = { defaultTemplate: 'base', async create() { log.push('create'); return session; }, async connect() { return session; } };
  assert.deepEqual(await probeSandboxProfile(provider), { template: 'base', user: 'ubuntu', home: '/home/ubuntu', os: 'Ubuntu 24.04.1 LTS', installed: ['git', 'python3'] });
  assert.deepEqual(log, ['create', 'run:echo "user=$(id -un)"', 'close']);
  assert.equal(parseSandboxProfile('base', 'user=ubuntu\nhome=relative\nos=Ubuntu\n'), undefined);
});

test('probe_failure_no_prompt_line: a failed probe gives no profile and no prompt line', async () => {
  const provider: SandboxProvider = { defaultTemplate: 'base', async create() { throw new Error('no capacity'); }, async connect() { throw new Error('unused'); } };
  const found = await probeSandboxProfile(provider);
  assert.equal(found, undefined);
  assert.equal(sandboxPromptLine(found), undefined);
});

test('prompt_same_bytes_across_requests: every run gets the same sandbox line, and none without a profile', async t => {
  const line = sandboxPromptText(profile);
  for (const [name, sandboxPrompt] of [['with profile', line], ['without profile', undefined]] as const) {
    const store = new SQLiteStore(); t.after(() => store.close());
    const prefixes: string[] = [];
    const llm = { async *stream(prompt: { prefix: readonly { content: string }[] }) { prefixes.push(prompt.prefix.map(item => item.content).join('\n')); yield { kind: 'text' as const, payload: { text: 'ok' } }; } };
    const app = new Application(store, llm as never, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, {
      tools: { schemas: () => [], catalog: () => '', execute: async () => ({ text: 'x' }) }, ...(sandboxPrompt ? { sandboxPrompt } : {}),
    });
    await app.handle({ id: 'm1', server: 's', channel: 'c', author: 'a', text: 'one' });
    await app.handle({ id: 'm2', server: 's', channel: 'c', author: 'a', text: 'two' });
    assert.ok(prefixes.length >= 2, name);
    assert.ok(prefixes.every(prefix => prefix === prefixes[0]), name);
    assert.equal(prefixes[0]!.includes('Sandbox for read, write, edit and shell'), sandboxPrompt !== undefined, name);
  }
});
