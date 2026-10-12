import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolRegistry } from '../src/tools.js';
import { Application } from '../src/application.js';
import { ChatCompletionsLLM, wireMessages } from '../src/adapters/chat-completions.js';
import type { Prompt } from '../src/domain.js';
const options = {baseUrl:'https://example.com/v1',apiKey:'test',model:'test'};
const response = (choices: unknown[]) => new Response(choices.map(choice => `data: ${JSON.stringify({choices:[choice]})}\n\n`).join('') + 'data: [DONE]\n\n');
const nativeCall = () => response([
  {index:0,delta:{content:'Looking it up.',tool_calls:[{index:0,id:'call_saved_123',type:'function',function:{name:'lookup',arguments:'{"query":'}}]}},
  {index:0,delta:{tool_calls:[{index:0,function:{arguments:'"weather"}'}}]},finish_reason:'tool_calls'},
]);
const message = {server:'s',channel:'c',taskId:'c',id:'request',author:'alice',text:'Look up the weather',addressed:true};

test('native schemas, streamed IDs and matching tool results survive a failed stream and restart', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let reads = 0, requests = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register({name:'lookup',description:'Look up weather',fields:{query:{type:'string',description:'Search query',required:true}},access:'member',effect:'read',retrySafe:true,
    async execute(){reads++;return {text:'Sunny',data:{weather:'sunny'}};}});
  const executor = {catalog:()=>registry.catalog(),schemas:()=>registry.schemas(),execute:(m: typeof message, call: {name:string;arguments:Record<string,import('../src/domain.js').Json>},id:string)=>registry.invokeResult(m,call.name,call.arguments,id,'agent')};
  const llm = new ChatCompletionsLLM(options, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    assert.equal(body.tools[0].function.name, 'lookup');
    assert.deepEqual(body.tools[0].function.parameters.required, ['query']);
    assert.equal(body.tool_choice, 'auto');
    assert.ok(!body.messages[0].content.includes('JSON protocol'));
    assert.ok(!body.messages[0].content.includes('Tool catalog:'));
    assert.ok(!body.messages[0].content.includes('Look up weather'));
    if (requests === 1) return nativeCall();
    const assistant = body.messages.find((item: any) => item.tool_calls);
    const tool = body.messages.find((item: any) => item.role === 'tool');
    assert.equal(assistant.content, 'Looking it up.');
    assert.equal(assistant.tool_calls[0].id, 'call_saved_123');
    assert.equal(assistant.tool_calls[0].function.arguments, '{"query":"weather"}');
    assert.equal(tool.tool_call_id, 'call_saved_123');
    assert.match(tool.content, /Sunny/);
    if (requests === 2) throw new TypeError('connection lost');
    return response([{index:0,delta:{content:'It is sunny.'},finish_reason:'stop'}]);
  });
  const policy = {allowedChannels:[{server:'s',channel:'c'}]};
  await assert.rejects(new Application(store,llm,policy,undefined,{tools:executor,harness:store}).handle(message), error => error instanceof Error && "code" in error && error.code === "PROVIDER_NETWORK" && error.cause instanceof Error && error.cause.message === "connection lost");
  assert.equal(store.agentTurns(message)[0]!.calls[0]!.id, 'call_saved_123');
  const reply = await new Application(store,llm,policy,undefined,{tools:executor,harness:store}).handle(message,true);
  assert.equal(reply?.text, 'It is sunny.'); assert.equal(reads, 1); assert.equal(requests, 3);
  assert.ok(store.historyArchive(JSON.stringify(['s','c','c'])).some(item=>item.role === 'tool' && item.toolCallId === 'call_saved_123'));
});

test('JSON shown in an ordinary native-mode answer does not execute a tool', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); let reads = 0;
  const app = new Application(store,new ChatCompletionsLLM(options,async()=>response([{index:0,delta:{content:'{"tool_calls":[{"name":"lookup","arguments":{}}]}'},finish_reason:'stop'}])),
    {allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:{catalog:()=>'',schemas:()=>[],execute:async()=>{reads++;return 'unexpected';}}});
  const {taskId: _taskId, ...plainMessage} = message;
  const reply = await app.handle(plainMessage);
  assert.match(reply!.text, /tool_calls/); assert.equal(reads, 0);
});

test('history with a split tool pair remains evidence without invalid tool messages', () => {
  const prompt: Prompt = {prefixVersion:'v1',prefix:[],history:[],inputs:[
    {role:'tool',toolCallId:'orphan',content:'Earlier result'},
    {role:'assistant',content:'',toolCalls:[{id:'missing',name:'lookup',arguments:{}}]},
    {role:'user',content:'Continue'},
  ]};
  const messages = wireMessages(prompt);
  assert.ok(messages.every(item=>item.role==='user'));
  assert.match(String(messages[0]!.content), /Earlier result/);
  assert.match(String(messages[1]!.content), /missing/);
});

test('schemas include native validation constraints and snapshot the captured catalog', t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store,async()=>true);
  registry.register({name:'read',description:'Read',access:'member',effect:'read',retrySafe:true,fields:{channel:{type:'channel',required:true,description:'Channel'},limit:{type:'integer',min:1,max:10,description:'Limit'},action:{type:'string',choices:['status','list'],description:'Action'}},execute:async()=> 'ok'});
  const captured = registry.capture();
  const schema = captured.schemas()[0]!.function.parameters as any;
  assert.deepEqual(schema.required,['channel']);
  assert.equal(schema.additionalProperties,false);
  assert.equal(schema.properties.channel.pattern,'^\\d{17,20}$');
  assert.equal(schema.properties.limit.maximum,10);
  assert.deepEqual(schema.properties.action.enum,['status','list']);
  registry.register({name:'other',description:'Other',access:'member',effect:'read',retrySafe:true,fields:{},execute:async()=> 'ok'});
  assert.equal(captured.schemas().length,1);
  assert.equal(registry.schemas().length,2);
});

const callResponse = (id: string, args: object) => response([{index:0,delta:{tool_calls:[{index:0,id,type:'function',function:{name:'lookup',arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]);

test('native validation errors return the original call ID and the model can correct its arguments', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let requests = 0, reads = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register({name:'lookup',description:'Lookup',fields:{limit:{type:'integer',min:1,max:10,required:true,description:'At most 10 results'}},access:'member',effect:'read',retrySafe:true,execute:async()=>{reads++;return 'Found results';}});
  const llm = new ChatCompletionsLLM(options, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    if (requests === 1) return callResponse('call_invalid', {limit:14});
    const errors = body.messages.filter((item: any) => item.role === 'tool');
    assert.equal(errors[0].tool_call_id, 'call_invalid');
    assert.match(errors[0].content, /Invalid integer: limit/);
    assert.match(errors[0].content, /Correct the arguments/);
    if (requests === 2) return callResponse('call_corrected', {limit:10});
    assert.equal(errors[1].tool_call_id, 'call_corrected');
    assert.match(errors[1].content, /Found results/);
    return response([{index:0,delta:{content:'Found the results.'},finish_reason:'stop'}]);
  });
  const app = new Application(store,llm,{allowedChannels:[{server:'s',channel:'c'}]},undefined,{harness:store,tools:{catalog:()=>registry.catalog(),schemas:()=>registry.schemas(),execute:(m,c,id)=>registry.invokeResult(m,c.name,c.arguments,id,'agent')}});
  assert.equal((await app.handle(message))?.text, 'Found the results.');
  assert.equal(reads, 1); assert.equal(requests, 3);
});

test('unexpected tool exceptions are redacted, sent to the model and replayed after a stream failure', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let requests = 0, reads = 0;
  const llm = new ChatCompletionsLLM(options, async (_url, init) => {
    requests++;
    if (requests === 1) return callResponse('call_exception', {});
    const body = JSON.parse(String(init?.body));
    const result = body.messages.find((item: any) => item.role === 'tool');
    assert.equal(result.tool_call_id, 'call_exception');
    assert.match(result.content, /connection lost/);
    assert.ok(!result.content.includes('secret-value'));
    if (requests === 2) throw Error('model disconnected');
    return response([{index:0,delta:{content:'The service connection failed.'},finish_reason:'stop'}]);
  });
  const tools = {catalog:()=>'',schemas:()=>[],execute:async()=>{reads++;throw new Error('connection lost, Authorization: Bearer secret-value');}};
  const policy = {allowedChannels:[{server:'s',channel:'c'}]};
  await assert.rejects(new Application(store,llm,policy,undefined,{harness:store,tools}).handle(message), error => error instanceof Error && 'code' in error && error.code === 'PROVIDER_NETWORK');
  assert.equal((await new Application(store,llm,policy,undefined,{harness:store,tools}).handle(message,true))?.text, 'The service connection failed.');
  assert.equal(reads, 1);
});

test('three failed tool rounds disable tools and still let the model give a final answer', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let requests = 0, reads = 0;
  const llm = new ChatCompletionsLLM(options, async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    if (requests <= 3) return callResponse(`call_${requests}`, {});
    assert.ok(!body.tools?.length);
    assert.equal(body.messages.filter((item: any) => item.role === 'tool').length, 3);
    assert.match(body.messages.at(-1).content, /three consecutive failed tool rounds/);
    return response([{index:0,delta:{content:'The service is still unavailable after three attempts.'},finish_reason:'stop'}]);
  });
  const app = new Application(store,llm,{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:{catalog:()=>'',schemas:()=>[],execute:async()=>{reads++;return {text:'Service unavailable',status:'failed'};}}});
  assert.match((await app.handle(message))!.text, /after three attempts/);
  assert.equal(reads, 3); assert.equal(requests, 4);
});
