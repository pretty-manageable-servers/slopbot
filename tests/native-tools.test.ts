import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolRegistry } from '../src/tools.js';
import { Application } from '../src/application.js';
import { ChatCompletionsLLM, wireMessages } from '../src/adapters/chat-completions.js';
import type { Prompt } from '../src/domain.js';
import { objectStorageTool, type UserFileStorage } from '../src/object-storage.js';
import { registerProfileTools } from '../src/profiles.js';
import { McpManager, mcpSchemaHash, mcpToolName, type McpTool } from '../src/mcp.js';
import { nativeToolInstructions, type ToolDefinition } from '../src/tools.js';
import type { SandboxProvider } from '../src/sandbox.js';
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
  registry.register({name:'lookup',surface:'top',description:'Look up weather',fields:{query:{type:'string',description:'Search query',required:true}},access:'member',effect:'read',retrySafe:true,
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
  registry.register({name:'read',surface:'top',description:'Read',access:'member',effect:'read',retrySafe:true,fields:{channel:{type:'channel',required:true,description:'Channel'},limit:{type:'integer',min:1,max:10,description:'Limit'},action:{type:'string',choices:['status','list'],description:'Action'}},execute:async()=> 'ok'});
  const captured = registry.capture();
  const schema = captured.schemas()[0]!.function.parameters as any;
  assert.deepEqual(schema.required,['channel']);
  assert.equal(schema.additionalProperties,false);
  assert.equal(schema.properties.channel.pattern,'^\\d{17,20}$');
  assert.equal(schema.properties.limit.maximum,10);
  assert.deepEqual(schema.properties.action.enum,['status','list']);
  registry.register({name:'other',surface:'top',description:'Other',access:'member',effect:'read',retrySafe:true,fields:{},execute:async()=> 'ok'});
  assert.equal(captured.schemas().length,1);
  assert.equal(registry.schemas().length,2);
});

const callResponse = (id: string, args: object) => response([{index:0,delta:{tool_calls:[{index:0,id,type:'function',function:{name:'lookup',arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]);

test('native validation errors return the original call ID and the model can correct its arguments', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let requests = 0, reads = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register({name:'lookup',surface:'top',description:'Lookup',fields:{limit:{type:'integer',min:1,max:10,required:true,description:'At most 10 results'}},access:'member',effect:'read',retrySafe:true,execute:async()=>{reads++;return 'Found results';}});
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

// WP3: the model surface. Only surface "top" tools are native; the prompt has no text protocol.
const plainTool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({ name, description: name, fields: {}, access: 'member', effect: 'read', retrySafe: true, execute: async () => 'ok', ...extra });
const voiceMessage = { ...message, source: 'voice' as const };

test('schemas_only_top_level', t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registry.register(plainTool('top_read', { surface: 'top' }));
  registry.register(plainTool('catalog_read'));
  registry.register(plainTool('remote_read', { surface: 'discovery' }));
  assert.deepEqual(registry.schemas(message).map(item => item.function.name), ['top_read']);
});

test('schemas_same_for_admin_and_member', t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async message => message.author === 'admin');
  registry.register(plainTool('top_admin', { surface: 'top', access: 'admin' }));
  registry.register(plainTool('top_member', { surface: 'top' }));
  const admin = JSON.stringify(registry.schemas({ ...message, author: 'admin' }));
  const member = JSON.stringify(registry.schemas({ ...message, author: 'alice' }));
  assert.equal(admin, member);
  assert.equal(registry.schemas(message).length, 2);
});

test('mcp_not_in_schemas', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  const remote: McpTool = { name: 'list_issues', inputSchema: { type: 'object', additionalProperties: false } };
  const manager = new McpManager('s', store, registry, async () => ({ listTools: async () => [remote], callTool: async () => ({ content: [] }), close: async () => {} }));
  t.after(() => manager.close());
  await manager.configure('admin', { action: 'save', id: 'github', url: 'https://github.example/mcp', transport: 'http', enabled: true, tools: [{ name: remote.name, schemaHash: mcpSchemaHash(remote), effect: 'read', access: 'member' }] });
  assert.equal(registry.definitions().find(tool => tool.provider === 'mcp:github')?.surface, 'discovery');
  assert.equal(registry.schemas(message).some(item => item.function.name === mcpToolName('github', remote.name)), false);
});

test('inline_memory_no_thread', t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registerProfileTools(registry, store);
  registry.register(objectStorageTool({ storage: {} as UserFileStorage, authorize: async () => {}, resolveAttachment: async () => { throw new Error('unused'); }, inspect: async () => '', send: async () => {} }));
  registry.register(plainTool('thread_write', { effect: 'write', retrySafe: false }));
  assert.equal(registry.requiresThread('profile', { action: 'set' }), false);
  assert.equal(registry.requiresThread('file_store', { action: 'write' }), false);
  assert.equal(registry.requiresThread('thread_write', {}), true);
});

test('confirm_flags', () => {
  const tool = objectStorageTool({ storage: {} as UserFileStorage, authorize: async () => {}, resolveAttachment: async () => { throw new Error('unused'); }, inspect: async () => '', send: async () => {} });
  // file_store writes run directly, like other writes. Only channels remove keeps Confirm.
  assert.equal(tool.confirm, undefined);
  assert.equal(tool.writes?.({ action: 'list' }), false);
  assert.equal(tool.writes?.({ action: 'delete' }), true);
});

test('file_store_to_sandbox', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const written: string[] = [];
  const session = { id: 'sandbox-1', run: async () => ({ stdout: '', stderr: '', exitCode: 0 }), read: async () => '', readBytes: async () => new Uint8Array(), write: async (path: string) => { written.push(path); }, renew: async () => {}, close: async () => {} };
  const provider = { defaultTemplate: 'base', create: async () => session, connect: async () => session } as unknown as SandboxProvider;
  const storage = { entry: async () => ({ record: {}, file: {} }), read: async () => ({ file: { path: 'report.txt' }, bytes: new TextEncoder().encode('hello') }) } as unknown as UserFileStorage;
  const services = { storage, authorize: async () => {}, resolveAttachment: async () => { throw new Error('unused'); }, inspect: async () => '', send: async () => {} };
  const args = { action: 'to_sandbox', path: 'report.txt', sandbox_path: '/home/user/report.txt' };
  const configured = new ToolRegistry(store, async () => true);
  configured.register(objectStorageTool({ ...services, store, provider }));
  assert.match((await configured.invokeResult(message, 'file_store', args, 'to-sandbox', 'agent')).text, /Copied report\.txt to sandbox \/home\/user\/report\.txt/);
  assert.deepEqual(written, ['/home/user/report.txt']);
  const unconfigured = new ToolRegistry(store, async () => true);
  unconfigured.register(objectStorageTool(services));
  assert.equal((await unconfigured.invokeResult(message, 'file_store', args, 'to-sandbox-none', 'agent')).text, 'Sandbox is not configured.');
});

test('no_text_protocol', async t => {
  const { Application } = await import('../src/application.js');
  const store = new SQLiteStore(); t.after(() => store.close());
  let reads = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register(plainTool('lookup', { surface: 'top', execute: async () => { reads++; return 'Found'; } }));
  const text = '{"tool_calls":[{"name":"lookup","arguments":{}}]}';
  const llm = { async *stream() { yield { kind: 'text' as const, payload: { text } }; } };
  const app = new Application(store, llm, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, { tools: { catalog: () => registry.catalog(), schemas: () => registry.schemas(), execute: (m, c, id) => registry.invokeResult(m, c.name, c.arguments, id, 'agent') } });
  assert.equal((await app.handle(message))?.text, text);
  assert.equal(reads, 0);
  assert.doesNotMatch(nativeToolInstructions, /JSON protocol|program_exec|task_start/);
  assert.match(nativeToolInstructions, /run_tools_code/);
});

test('voice tools are offered only in voice runs', t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registry.register(plainTool('voice_say', { surface: 'top', scope: 'discord' }));
  assert.deepEqual(registry.schemas(voiceMessage).map(item => item.function.name), ['voice_say']);
  assert.deepEqual(registry.schemas(message).map(item => item.function.name), []);
  assert.deepEqual(registry.schemas().map(item => item.function.name), []);
});

const twoLookups = () => response([
  {index:0,delta:{tool_calls:[{index:0,id:'call_one',type:'function',function:{name:'lookup',arguments:'{"query":"one"}'}}]}},
  {index:0,delta:{tool_calls:[{index:1,id:'call_two',type:'function',function:{name:'lookup',arguments:'{"query":"two"}'}}]},finish_reason:'tool_calls'},
]);
const chatRequest = {server:'s',channel:'c',id:'request',author:'alice',text:'Look up the weather',addressed:true};
const weatherRegistry = (store: SQLiteStore, onFirstCall: () => Promise<void>, ran: string[]) => {
  const registry = new ToolRegistry(store, async () => true);
  registry.register({name:'lookup',surface:'top',description:'Look up weather',fields:{query:{type:'string',description:'Search query',required:true}},access:'member',effect:'read',retrySafe:true,
    async execute(_context, args){ ran.push(String(args.query)); if (ran.length === 1) await onFirstCall(); return {text:'Sunny '+String(args.query)}; }});
  return {registry, executor: {catalog:()=>registry.catalog(),schemas:()=>registry.schemas(),execute:(m: typeof chatRequest, call: {name:string;arguments:Record<string,import('../src/domain.js').Json>},id:string)=>registry.invokeResult(m,call.name,call.arguments,id,'agent')}};
};

test('chat_change_does_not_skip_calls', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const ran: string[] = [];
  await store.ingest({...chatRequest, id:'earlier', author:'bob', text:'Earlier note'});
  // Editing an earlier message in the channel changes the chat during the first call.
  const {executor} = weatherRegistry(store, async () => { await store.ingest({...chatRequest, id:'earlier', author:'bob', text:'Earlier note, now edited', revisionTimestamp:2}); }, ran);
  let requests = 0;
  const llm = new ChatCompletionsLLM(options, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    if (requests === 1) return twoLookups();
    const tools = body.messages.filter((item: any) => item.role === 'tool');
    assert.deepEqual(tools.map((item: any) => item.tool_call_id), ['call_one', 'call_two']);
    assert.match(tools[0].content, /Sunny one/);
    assert.match(tools[1].content, /Sunny two/);
    assert.ok(!/"error"|failed/.test(tools[1].content));
    // The edit reaches the model as a note in its next tool round.
    assert.match(JSON.stringify(body.messages), /Since you started[\s\S]*edited a message[\s\S]*Earlier note, now edited/);
    return response([{index:0,delta:{content:'Done.'},finish_reason:'stop'}]);
  });
  const reply = await new Application(store,llm,{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:executor,harness:store}).handle(chatRequest);
  assert.equal(reply?.text, 'Done.');
  assert.deepEqual(ran, ['one', 'two']); assert.equal(requests, 2);
});

test('request_edit_during_run_is_a_note', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const ran: string[] = [];
  const {executor} = weatherRegistry(store, async () => { await store.ingest({...chatRequest, text:'Look up the forecast for Oslo', revisionTimestamp:2}); }, ran);
  let requests = 0;
  const llm = new ChatCompletionsLLM(options, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    if (requests === 1) return twoLookups();
    const text = JSON.stringify(body.messages);
    assert.match(text, /The user edited their request to: Look up the forecast for Oslo/);
    return response([{index:0,delta:{content:'Done.'},finish_reason:'stop'}]);
  });
  const reply = await new Application(store,llm,{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:executor,harness:store}).handle(chatRequest);
  assert.equal(reply?.text, 'Done.'); assert.equal(requests, 2); assert.deepEqual(ran, ['one', 'two']);
  assert.equal((await store.canonicalMessage('s', 'request'))?.text, 'Look up the forecast for Oslo');
});
