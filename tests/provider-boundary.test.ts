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
  // The envelope parser and the template parser use the same limit.
  const envelope = Array.from({ length: 9 }, (_, index) => ({ name: 'read', id: `call_${index}`, arguments: {} }));
  assert.equal(parseToolCalls(JSON.stringify({ tool_calls: envelope }))?.length, 9);
  assert.equal(gemmaToolCalls(Array.from({ length: 9 }, () => '<|tool_call>call:read{}<tool_call|>').join('\n'))?.length, 9);
});

test('image transport bytes do not consume the text context budget', () => {
  const image = { url: 'data:image/jpeg;base64,' + 'A'.repeat(400000), label: 'Bounded 768px file frame' };
  const budgeted = withInspectionBudget({ contextTokenLimit: 200000, outputTokenLimit: 50000 }, { ...prompt, tools: [], inputs: [{ role: 'user', content: 'Inspect this image.', images: [image] }] });
  assert.equal(budgeted.maxOutputTokens, 50000);
});

for (const [name, chunk, code, done] of [
  ['truncated stream', { choices: [{ index: 0, delta: { content: 'partial' } }] }, 'PROVIDER_STREAM_INCOMPLETE', false],
  ['malformed native arguments', { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'read', arguments: '{"unfinished":' } }] }, finish_reason: 'tool_calls' }] }, 'PROVIDER_TOOL_PROTOCOL', true],
  ['provider filter', { choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }, 'PROVIDER_CONTENT_FILTERED', true],
  ['empty completed reply', { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, 'MODEL_EMPTY_OUTPUT', true],
] as const) test(`${name} has an explicit code and emits no executable call`, async () => {
  const llm = new ChatCompletionsLLM(options, async () => response(chunk, done));
  let calls = 0;
  await assert.rejects(async () => { for await (const event of llm.stream(prompt)) if (event.kind === 'tool_call') calls++; }, error => describeError(error).code === code);
  assert.equal(calls, 0);
});
