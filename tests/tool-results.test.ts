import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SQLiteStore} from '../src/adapters/sqlite.js';
import {Application} from '../src/application.js';
import {ToolRegistry} from '../src/tools.js';
const request={id:'m',server:'s',channel:'c',author:'a',text:'do it'};
test('structured handoffs work regardless of display wording',async t=>{
 const store=new SQLiteStore();t.after(()=>store.close());
 const app=new Application(store,{async *stream(){yield {kind:'text',payload:{text:'{"tool_calls":[{"name":"task_start","arguments":{}}]}'}};}},{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:{catalog:()=>'',execute:async()=>({text:'Completely different wording',handoff:{threadId:'123'}})}});
 assert.equal((await app.handle(request))?.text,'Task started in <#123>. Updates will appear there.');
 assert.equal(typeof store.agentTurns(request)[0]?.results['0'],'object');
});
test('structured tool sources reach reply manifests without inspection-specific SQL',async t=>{
 const store=new SQLiteStore();t.after(()=>store.close());
 await store.ingest({...request,id:'source',text:'source'});
 const app=new Application(store,{async *stream(){yield {kind:'text',payload:{text:'unused'}};}},{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:{catalog:()=>'',suggest:()=>({name:'read',arguments:{}}),execute:async()=>({text:'confirmed',sources:[{kind:'message',server:'s',channel:'c',id:'source'}],artifacts:[{url:'https://example.com/report',label:'report'}]})}});
 const reply=await app.handle(request);assert.equal(reply?.text,'confirmed\n[report](https://example.com/report)');
 const output={...request,id:'output',text:reply!.text};await store.ingest(output);await store.linkOutput(output,reply!.runId,request.id);
 await store.remove('s','c','source');assert.equal(store.canonicalMessage('s','output'),undefined);
});
test('old plain-text operation results remain readable',async t=>{
 const store=new SQLiteStore();t.after(()=>store.close());const registry=new ToolRegistry(store,async()=>false);
 registry.register({name:'read',description:'read',fields:{},access:'member',effect:'read',retrySafe:true,execute:async()=>{throw Error('must replay');}});
 store.beginOperation({message:request,operationId:'old',isAdmin:false,source:'agent',toolName:'read',arguments:{},resource:null,assertActive:async()=>{}},'read',{});store.endOperation('old','old result');
 assert.deepEqual(await registry.invokeResult(request,'read',{},'old','agent'),{text:'old result'});
});

test('request context changes during a tool still abort before another model turn', async t => {
 const { RequestError } = await import('../src/errors.js');
 const store=new SQLiteStore();t.after(()=>store.close());let rounds=0;
 const failure=new RequestError('CONTEXT_CHANGED','Source edited','Retry with fresh context');
 const app=new Application(store,{async *stream(){rounds++;yield {kind:'text',payload:{text:'{"tool_calls":[{"name":"read","arguments":{}}]}'}};}},{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:{catalog:()=>'',execute:async()=>{throw failure;}}});
 await assert.rejects(app.handle(request),error=>error===failure);
 assert.equal(rounds,1);
});

test('a model that ignores the recovery limit cannot execute a fourth failed tool round', async t => {
 const store=new SQLiteStore();t.after(()=>store.close());let rounds=0,calls=0;
 const app=new Application(store,{async *stream(){rounds++;yield {kind:'text',payload:{text:'{"tool_calls":[{"name":"read","arguments":{}}]}'}};}},{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:{catalog:()=>'',execute:async()=>{calls++;return {text:'Unavailable',status:'failed'};}}});
 assert.match((await app.handle(request))!.text,/Stopped after three consecutive failed tool rounds/);
 assert.equal(calls,3);assert.equal(rounds,4);
});
