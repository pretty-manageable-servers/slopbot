import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Application } from '../src/application.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { showCodeRows } from '../src/adapters/discord-code.js';
import { UserFileStorage, objectStorageTool } from '../src/object-storage.js';
import { runToolsCodeTool } from '../src/run-tools-code.js';
import { sandboxFileTools } from '../src/sandbox-tools.js';
import { sandboxManageTool } from '../src/sandbox.js';
import type { ToolActivity } from '../src/tool-activity.js';
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

test('activity_keeps_code: a final status update keeps the code of a run_tools_code call', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const seen: ToolActivity[] = [];
  let rounds = 0;
  const code = 'return text("hello")';
  const app = new Application(store, {
    async *stream() {
      yield ++rounds === 1
        ? { kind: 'tool_call' as const, payload: [{ name: 'run_tools_code', arguments: { code } }] }
        : { kind: 'text' as const, payload: { text: 'Answer' } };
    },
  }, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, {
    onToolActivity: async (_message, activity) => { seen.push(activity); },
    tools: {
      catalog: () => '',
      schemas: () => [],
      execute: async (_message, call, id, _version, invocation) => {
        // The program reports its own running status with its code, as runToolsCodeTool does.
        await invocation?.onActivity?.({ id, name: call.name, arguments: call.arguments, status: 'running', code });
        return { text: 'hello', data: { childCalls: [] } } as unknown as string;
      },
    },
  });
  const reply = await app.handle({ server: 's', channel: 'c', author: 'person', id: 'request', text: 'Run code', addressed: true });
  assert.equal(seen.at(-1)?.status, 'completed');
  assert.equal(seen.at(-1)?.code, code);
  assert.equal(reply?.toolActivity?.[0]?.code, code);
});

test('show_code_button_attached: a run with code gets a Show code button in summary mode and in full mode when the code is long', () => {
  const short: ToolActivity = { id: 'short', name: 'run_tools_code', status: 'completed', code: 'return 1' };
  const long: ToolActivity = { id: 'long', name: 'run_tools_code', status: 'completed', code: 'x\n'.repeat(20) };
  const child: ToolActivity = { id: 'child', name: 'web_search', status: 'completed', parentId: 'short' };
  const summary = showCodeRows([short, long, child], 'summary');
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0]!.toJSON().components.map(button => (button as { custom_id?: string }).custom_id), ['slopcode:short', 'slopcode:long']);
  const full = showCodeRows([short, long], 'full');
  assert.deepEqual(full[0]!.toJSON().components.map(button => (button as { custom_id?: string }).custom_id), ['slopcode:long']);
  assert.equal(showCodeRows([short], 'none').length, 0);
  assert.equal(showCodeRows([short], 'full').length, 0);
});
