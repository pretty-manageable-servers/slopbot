import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionsLLM, gemmaToolCalls } from '../src/adapters/chat-completions.js';
import { describeError } from '../src/errors.js';
import { withInspectionBudget } from '../src/context.js';
import { parseToolCalls } from '../src/tools.js';
import type { Prompt } from '../src/domain.js';

const options = { baseUrl: 'https://api.pmservers.org/ai/v1', model: 'nimbus', apiKey: 'test-only' };
const prompt: Prompt = { prefixVersion: 'boundary', prefix: [], history: [], inputs: [{ role: 'user', content: 'Read evidence' }], tools: [{ type: 'function', function: { name: 'read', description: 'Read evidence', parameters: { type: 'object', properties: {} } } }] };
const response = (chunk: unknown, done = true) => new Response(`data: ${JSON.stringify(chunk)}\n\n${done ? 'data: [DONE]\n\n' : ''}`);

test('nine native calls fit the shared batch limit and retain every call ID', async () => {
  const calls = Array.from({ length: 9 }, (_, index) => ({ index, id: `call_${index}`, function: { name: 'read', arguments: '{}' } }));
  const llm = new ChatCompletionsLLM(options, async () => response({ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] }));
  let result: unknown;
  for await (const event of llm.stream(prompt)) if (event.kind === 'tool_call') result = event.payload;
  assert.deepEqual(result, calls.map(call => ({ id: call.id, name: 'read', arguments: {} })));
});

test('the internal and legacy envelope parser uses the same larger batch limit', () => {
  const calls = Array.from({ length: 9 }, (_, index) => ({ name: 'read', id: `call_${index}`, arguments: {} }));
  assert.equal(parseToolCalls(JSON.stringify({ tool_calls: calls }))?.length, 9);
});

for (const [name, chunk, code, done] of [
  ['truncated stream', { choices: [{ index: 0, delta: { content: 'partial' } }] }, 'PROVIDER_STREAM_INCOMPLETE', false],
  ['malformed native arguments', { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'read', arguments: '{"unfinished":' } }] }, finish_reason: 'tool_calls' }] }, 'PROVIDER_TOOL_PROTOCOL', true],
  ['provider filter', { choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }, 'PROVIDER_CONTENT_FILTERED', true],
] as const) test(`${name} has an explicit code and emits no executable call`, async () => {
  const llm = new ChatCompletionsLLM(options, async () => response(chunk, done));
  let calls = 0;
  await assert.rejects(async () => { for await (const event of llm.stream(prompt)) if (event.kind === 'tool_call') calls++; }, error => describeError(error).code === code);
  assert.equal(calls, 0);
});

test('image transport bytes do not consume the text context budget', () => {
  const image = { url: 'data:image/jpeg;base64,' + 'A'.repeat(400000), label: 'Bounded 768px file frame' };
  const budgeted = withInspectionBudget({ contextTokenLimit: 200000, outputTokenLimit: 50000 }, { ...prompt, tools: [], inputs: [{ role: 'user', content: 'Inspect this image.', images: [image] }] });
  assert.equal(budgeted.maxOutputTokens, 50000);
});

test('provider network failure has a specific code', async () => {
  const llm = new ChatCompletionsLLM(options, async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(async () => { for await (const event of llm.stream(prompt)) void event; }, error => describeError(error).code === 'PROVIDER_NETWORK');
});

test('a single response choice without an explicit index is not silently discarded', async () => {
  const llm = new ChatCompletionsLLM(options, async () => response({ choices: [{ delta: { content: 'Complete reply.' }, finish_reason: 'stop' }] }));
  let text = ''; for await (const event of llm.stream(prompt)) if (event.kind === 'text') text += event.payload.text;
  assert.equal(text, 'Complete reply.');
});

test('a generation without a per-call override sends the configured provider allowance', async () => {
  const llm = new ChatCompletionsLLM({ ...options, outputTokens: 30000 }, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 30000);
    return response({ choices: [{ index: 0, delta: { content: 'Complete reply.' }, finish_reason: 'stop' }] });
  });
  for await (const event of llm.stream(prompt)) void event;
});

test('an empty completed model response is a failure rather than a successful empty reply', async () => {
  const llm = new ChatCompletionsLLM(options, async () => response({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  await assert.rejects(async () => { for await (const event of llm.stream(prompt)) void event; }, error => describeError(error).code === 'MODEL_EMPTY_OUTPUT');
});

test('a broken response body has a specific stream code and preserves partial output', async () => {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));
    else controller.error(new TypeError('connection terminated'));
  } });
  const llm = new ChatCompletionsLLM(options, async () => new Response(body));
  let text = '';
  await assert.rejects(async () => { for await (const event of llm.stream(prompt)) if (event.kind === 'text') text += event.payload.text; }, error => describeError(error).code === 'PROVIDER_STREAM_INTERRUPTED');
  assert.equal(text, 'partial');
});

test('template tool batches share the larger batch allowance',()=>{
 const text=Array.from({length:9},()=>'<|tool_call>call:read{}<tool_call|>').join('\n');
 assert.equal(gemmaToolCalls(text)?.length,9);
});
