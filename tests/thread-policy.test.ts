import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { NATIVE_THREAD_POLICY } from '../src/thread-policy.js';
import { ToolRegistry } from '../src/tools.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';

test('every native write registration has an explicit central thread policy', t => {
  const root = new URL('../../src/', import.meta.url), names = new Set<string>();
  for (const file of readdirSync(root, { recursive: true }).filter(file => typeof file === 'string' && file.endsWith('.ts'))) {
    const tree = ts.createSourceFile(String(file), readFileSync(new URL(String(file), root), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const props = new Map(node.properties.filter(ts.isPropertyAssignment).map(property => [property.name.getText(tree), property.initializer]));
        const name = props.get('name'), effect = props.get('effect');
        if (name && ts.isStringLiteral(name) && effect && ts.isStringLiteral(effect) && effect.text === 'write') names.add(name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  for (const name of names) assert.ok(name in NATIVE_THREAD_POLICY, `Native write tool ${name} needs a policy in src/thread-policy.ts`);
  assert.deepEqual([...names].sort(), Object.keys(NATIVE_THREAD_POLICY).sort(), 'Remove stale policy entries when removing a tool');
  const store = new SQLiteStore(); t.after(() => store.close()); const registry = new ToolRegistry(store, async () => true);
  for (const name of names) registry.register({ name, description: name, fields: {}, access: 'member', effect: 'write', retrySafe: true, execute: async () => '' });
  for (const tool of registry.definitions()) {
    const policy = NATIVE_THREAD_POLICY[tool.name as keyof typeof NATIVE_THREAD_POLICY];
    assert.equal(registry.requiresThread(tool.name, { action: 'set' }), policy === 'thread', tool.name);
  }
  assert.equal(registry.requiresThread('sandbox_manage', { action: 'build_template' }), true);
  assert.equal(registry.requiresThread('sandbox_manage', { action: 'close' }), false);
});
