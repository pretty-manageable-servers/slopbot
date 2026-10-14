// Run against a built checkout with SLOPBOT_AUDIT_ROOT=/path/to/checkout.
// Each probe uses APIs that existed before the bug fixes, so a baseline failure
// identifies incorrect behavior rather than a missing newly added export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.SLOPBOT_AUDIT_ROOT ?? process.cwd();
const load = path => import(pathToFileURL(resolve(root, `dist/src/${path}.js`)).href);
const { SQLiteStore } = await load('adapters/sqlite');
const { Application } = await load('application');
const { ChatCompletionsLLM } = await load('adapters/chat-completions');
const { ToolRegistry } = await load('tools');
const { registerReportTools } = await load('search/reports');
const { inspectFile } = await load('files');
const request = { server: 's', channel: 'c', author: 'person', id: 'request', text: 'Complete the reads', addressed: true };
const schema = { type: 'function', function: { name: 'read', description: 'Read source evidence', parameters: { type: 'object', properties: {} } } };
const summary = JSON.stringify({ goal: 'Finish the reads', constraints: [], decisions: [], disagreements: [], progress: ['Earlier reads completed.'], artifacts: [], pending_actions: [] });
const options = { baseUrl: 'https://api.pmservers.org/ai/v1', model: 'nimbus', apiKey: 'test-only' };
const prompt = { prefixVersion: 'regression', prefix: [], history: [], inputs: [{ role: 'user', content: 'Read evidence' }], tools: [schema] };

test('native schemas are sent in the provider tools field', async () => {
  const llm = new ChatCompletionsLLM(options, async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init.body)).tools, [schema]);
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  for await (const event of llm.stream(prompt)) void event;
});

test('native streamed calls retain their provider call ID', async () => {
  const llm = new ChatCompletionsLLM(options, async () => new Response('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_source","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'));
  const events = []; for await (const event of llm.stream(prompt)) events.push(event);
  assert.equal(events.find(event => event.kind === 'tool_call')?.payload[0]?.id, 'call_source');
});

test('the default round allowance completes ten consecutive tool reads', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); let reads = 0;
  const app = new Application(store, { async *stream() {
    // Native tool calls only: the text protocol was removed.
    yield reads < 10 ? { kind: 'tool_call', payload: [{ name: 'read', arguments: {} }] } : { kind: 'text', payload: { text: 'Ten reads finished.' } };
  } }, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, { tools: { catalog: () => '', execute: async () => { reads++; return 'Read completed.'; } } });
  assert.equal((await app.handle(request))?.text, 'Ten reads finished.'); assert.equal(reads, 10);
});

for (const name of ['decision_lookup', 'conversation_summary']) test(`${name} uses the configured internal generation allowance`, async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.ingest({ ...request, id: 'source', text: 'We decided to ship Friday.', timestamp: 1 });
  const registry = new ToolRegistry(store, async () => false);
  registerReportTools(registry, { store, authorize: async () => {}, llm: { outputTokenLimit: 50000, contextTokenLimit: 200000, async *stream(input) {
    assert.equal(input.maxOutputTokens, 50000); yield { kind: 'text', payload: { text: 'Friday was agreed.' } };
  } } });
  await registry.invokeResult(request, name, { query: 'ship' }, name, 'agent');
});

test('file inspection uses the configured internal generation allowance', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const source = { ...request, id: 'source', attachments: [{ name: 'sample.txt', url: 'https://cdn.discordapp.com/sample.txt' }] };
  await store.ingest(source);
  const llm = { outputTokenLimit: 50000, contextTokenLimit: 200000, async *stream(input) { assert.equal(input.maxOutputTokens, 50000); yield { kind: 'text', payload: { text: 'Inspected sample.' } }; } };
  const context = { message: request, operationId: 'file', isAdmin: false, source: 'agent', toolName: 'file_store', arguments: {}, resource: null, assertActive: async () => {} };
  await inspectFile({ store, llm, decoder: { read: async () => ({ text: 'Sample evidence.', images: [] }) } }, context, 'sample.txt', 'text/plain', new Uint8Array(), 'What is in it?');
});

test('long working context is checkpointed instead of aborting a tool loop', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); let reads = 0;
  const app = new Application(store, { async *stream(input) {
    if (input.purpose === 'checkpoint') { yield { kind: 'text', payload: { text: summary } }; return; }
    if (reads < 8) yield { kind: 'tool_call', payload: [{ id: `call_${reads}`, name: 'read', arguments: {} }] };
    else yield { kind: 'text', payload: { text: 'Eight reads finished.' } };
  } }, { allowedChannels: [{ server: 's', channel: 'c' }], maxInputChars: 8000, maxOutputTokens: 1024 }, undefined,
    { tools: { catalog: () => '', schemas: () => [schema], execute: async () => { reads++; return { text: 'Evidence: ' + 'x'.repeat(4000) }; } } });
  assert.equal((await app.handle({ ...request, taskId: 'task' }))?.text, 'Eight reads finished.'); assert.equal(reads, 8);
});

test('history selection leaves room for the first successful tool result', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); let replies = 0, reads = 0;
  const app = new Application(store, { async *stream(input) {
    if (input.purpose === 'checkpoint') { yield { kind: 'text', payload: { text: summary } }; return; }
    if (++replies === 1) yield { kind: 'text', payload: { text: 'Previous evidence: ' + 'h'.repeat(5000) } };
    else if (replies === 2) yield { kind: 'tool_call', payload: [{ id: 'call_profile', name: 'read', arguments: {} }] };
    else { assert.ok(input.inputs.some(item => item.content.includes('x'.repeat(1900))), 'History packing must preserve working space for the tool evidence'); yield { kind: 'text', payload: { text: 'First read finished.' } }; }
  } }, { allowedChannels: [{ server: 's', channel: 'c' }], maxInputChars: 8000, maxOutputTokens: 1024 }, undefined,
    { tools: { catalog: () => '', schemas: () => [schema], execute: async () => { reads++; return { text: 'Source result: ' + 'x'.repeat(4000) }; } } });
  await app.handle({ ...request, taskId: 'task' });
  assert.equal((await app.handle({ ...request, id: 'next', taskId: 'task' }))?.text, 'First read finished.'); assert.equal(reads, 1);
});
