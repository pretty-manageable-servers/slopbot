import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { UserFileStorage, objectStorageTool } from '../src/object-storage.js';
import { runToolsCodeTool } from '../src/run-tools-code.js';
import { sandboxFileTools } from '../src/sandbox-tools.js';
import { sandboxManageTool } from '../src/sandbox.js';
import { ToolRegistry } from '../src/tools.js';

test('run_tools_code_registered_last: its core catalog lists the tools registered before it', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registry.register(sandboxManageTool(store));
  for (const tool of sandboxFileTools(store)) registry.register(tool);
  registry.register(objectStorageTool({
    storage: new UserFileStorage(store), authorize: async () => {}, resolveAttachment: async message => message,
    inspect: async () => '', send: async () => {},
  }));
  registry.register(runToolsCodeTool(registry, { store }));
  const description = registry.definitions().find(tool => tool.name === 'run_tools_code')!.description;
  assert.match(description, /^- sandbox_manage\(/m);
  assert.match(description, /^- file_store\(/m);
  // Top-level tools are native tools, not catalog entries.
  assert.doesNotMatch(description, /^- (shell|read|write|edit)\(/m);
});
