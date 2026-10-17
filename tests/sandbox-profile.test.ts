import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { Application } from '../src/application.js';
import { sandboxPromptText, type SandboxProfile } from '../src/sandbox-profile.js';

const profile: SandboxProfile = { template: 'base', user: 'ubuntu', home: '/home/ubuntu', os: 'Ubuntu 24.04.1 LTS', installed: ['python3', 'node', 'git'] };

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
