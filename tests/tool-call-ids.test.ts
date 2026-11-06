import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { Application } from '../src/application.js';
import { ChatCompletionsLLM } from '../src/adapters/chat-completions.js';
import type { ModelEvent, ModelTool, Prompt } from '../src/domain.js';
import type { ToolActivity } from '../src/tool-activity.js';

const options = {baseUrl:'https://example.com/v1',apiKey:'test',model:'test'};
const response = (choices: unknown[]) => new Response(choices.map(choice => `data: ${JSON.stringify({choices:[choice]})}\n\n`).join('') + 'data: [DONE]\n\n');
const message = {server:'s',channel:'c',taskId:'c',id:'request',author:'alice',text:'Look up the weather',addressed:true};
const policy = {allowedChannels:[{server:'s',channel:'c'}]};
const lookup: ModelTool = {type:'function',function:{name:'lookup',description:'Look up weather',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}};

// The first reply streams `chunks`; the second answers in text. Returns what the stream yielded, what the console saw, and the tool call IDs the provider got back.
async function lookUp(t: TestContext, chunks: unknown[], offered: ModelTool[]) {
  const store = new SQLiteStore(); t.after(() => store.close());
  const streamed: ModelEvent[] = [], activity: ToolActivity[] = [], bodies: any[] = [];
  const provider = new ChatCompletionsLLM(options, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? response(chunks) : response([{index:0,delta:{content:'Sunny.'},finish_reason:'stop'}]);
  });
  const llm = { async *stream(prompt: Prompt) { for await (const event of provider.stream(prompt)) { streamed.push(event); yield event; } } };
  const tools = { schemas: () => offered, catalog: () => '', execute: async () => 'Sunny' };
  const reply = await new Application(store, llm, policy, undefined, { harness: store, tools, onToolActivity: async (_message, event) => { activity.push(event); } }).handle(message);
  assert.equal(reply?.text, 'Sunny.');
  const sentCalls = bodies[1].messages.find((item: any) => item.tool_calls)?.tool_calls ?? [];
  return { streamed, activity, sentCalls };
}

test('a provider call ID goes on every streamed input chunk, the final call and the tool activity', async t => {
  const { streamed, activity, sentCalls } = await lookUp(t, [
    {index:0,delta:{tool_calls:[{index:0,id:'call_saved_123',type:'function',function:{name:'lookup',arguments:'{"query":'}}]}},
    {index:0,delta:{tool_calls:[{index:0,function:{arguments:'"weather"}'}}]},finish_reason:'tool_calls'},
  ], [lookup]);
  const input = streamed.filter(event => event.kind === 'tool_input').map(event => event.payload);
  assert.deepEqual(input.map(payload => payload.id), ['call_saved_123', 'call_saved_123']);
  assert.deepEqual(streamed.find(event => event.kind === 'tool_call')?.payload, [{name:'lookup',arguments:{query:'weather'},id:'call_saved_123'}]);
  assert.ok(activity.length > 0);
  assert.deepEqual([...new Set(activity.map(event => event.callId))], ['call_saved_123']);
  assert.deepEqual(sentCalls.map((call: any) => call.id), ['call_saved_123']);
});

test('input chunks streamed before the provider call ID carry no ID; later chunks and the tool activity do', async t => {
  const { streamed, activity } = await lookUp(t, [
    {index:0,delta:{tool_calls:[{index:0,function:{name:'lookup',arguments:'{"query":'}}]}},
    {index:0,delta:{tool_calls:[{index:0,id:'call_late',function:{arguments:'"weather"}'}}]},finish_reason:'tool_calls'},
  ], [lookup]);
  assert.deepEqual(streamed.filter(event => event.kind === 'tool_input').map(event => event.payload), [
    {index:0,name:'lookup',text:'{"query":'},
    {index:0,name:'lookup',text:'"weather"}',id:'call_late'},
  ]);
  assert.deepEqual([...new Set(activity.map(event => event.callId))], ['call_late']);
});

test('a call without a provider ID gets a call_ ID on its tool activity, and the provider gets the same ID back', async t => {
  // With no tools offered the provider need not send IDs, so the call has none.
  const { streamed, activity, sentCalls } = await lookUp(t, [
    {index:0,delta:{tool_calls:[{index:0,function:{name:'lookup',arguments:'{"query":"weather"}'}}]},finish_reason:'tool_calls'},
  ], []);
  assert.ok(streamed.some(event => event.kind === 'tool_input'));
  assert.ok(streamed.every(event => event.kind !== 'tool_input' || event.payload.id === undefined));
  const [callId] = [...new Set(activity.map(event => event.callId))];
  assert.match(callId!, /^call_/);
  assert.deepEqual(sentCalls.map((call: any) => call.id), [callId]);
});
