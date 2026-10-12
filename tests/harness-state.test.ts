import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HarnessMachine, restoreHarness, HarnessInterrupted} from '../src/harness-state.js';
import {Application} from '../src/application.js';
import {SQLiteStore} from '../src/adapters/sqlite.js';
import {ToolError,UncertainActionError,ToolRegistry} from '../src/tools.js';
import type {LLM} from '../src/ports.js';
const message={id:'m',server:'s',channel:'c',author:'a',text:'do the task'};
const policy={allowedChannels:[{server:'s',channel:'c'}]};
const kind=(machine:HarnessMachine)=>machine.state.kind;

test('Auger streaming, failure and interruption transitions',()=>{
 const machine=new HarnessMachine();
 assert.throws(()=>machine.dispatch({type:'ToolResult',id:'missing'}),/Invalid/);
 machine.dispatch({type:'SendMessage'});machine.dispatch({type:'StreamFailed'});
 assert.equal(kind(machine),'StreamingFailed');
 machine.dispatch({type:'SendMessage'});machine.dispatch({type:'Interrupt'});
 machine.dispatch({type:'SendMessage'});machine.dispatch({type:'StreamInterrupted'});
 assert.equal(kind(machine),'Streaming');
 machine.dispatch({type:'Interrupt'});machine.dispatch({type:'StreamInterrupted'});
 assert.equal(kind(machine),'StreamingInterrupted');
 machine.dispatch({type:'SendMessage'});machine.dispatch({type:'StreamCompleted'});
 assert.equal(kind(machine),'WaitingForUserMessage');
});
test('per-call decisions wait for every call and held results require a message',()=>{
 const machine=new HarnessMachine();machine.dispatch({type:'SendMessage'});
 machine.dispatch({type:'ToolsRequested',ids:['one','two']});
 machine.dispatch({type:'ToolDecision',id:'one',decision:'approve'});
 machine.dispatch({type:'SendMessage'});
 machine.dispatch({type:'ToolResult',id:'one'});
 assert.equal(kind(machine),'ToolPhase');
 machine.dispatch({type:'ToolDecision',id:'two',decision:'deny_withhold'});
 assert.equal(kind(machine),'ToolResultsHeld');
 machine.dispatch({type:'SendMessage'});assert.equal(kind(machine),'Streaming');
 machine.dispatch({type:'ToolsRequested',ids:['denied']});
 machine.dispatch({type:'ToolDecision',id:'denied',decision:'deny_continue'});
 assert.equal(kind(machine),'ToolResultsHeld');
});
test('mixed denied and approved tools continue; interrupted calls are terminal',()=>{
 const machine=new HarnessMachine();machine.dispatch({type:'SendMessage'});
 machine.dispatch({type:'ToolsRequested',ids:['a','b']});
 machine.dispatch({type:'ToolDecision',id:'a',decision:'deny_continue'});
 machine.dispatch({type:'ToolDecision',id:'b',decision:'approve'});
 machine.dispatch({type:'ToolResult',id:'b'});assert.equal(kind(machine),'Streaming');
 machine.dispatch({type:'ToolsRequested',ids:['c','d']});
 machine.dispatch({type:'ToolDecision',id:'c',decision:'approve'});
 machine.dispatch({type:'Interrupt'});assert.equal(kind(machine),'Streaming');
 assert.throws(()=>machine.dispatch({type:'ToolResult',id:'c'}),/Invalid/);
});
test('restoration never assumes an in-flight stream or tool completed',()=>{
 assert.equal(restoreHarness({kind:'Streaming'}).kind,'StreamingInterrupted');
 const restored=restoreHarness({kind:'ToolPhase',queuedMessage:false,calls:[{id:'a',state:'Running',denied:false},{id:'b',state:'DoneContinue',denied:false}]});
 assert.equal(restored.kind,'ToolPhase');
 if(restored.kind==='ToolPhase')assert.deepEqual(restored.calls.map(call=>call.state),['Undecided','DoneContinue']);
});
test('runner journals lifecycle and holds an all-rejected batch without more model calls',async t=>{
 const store=new SQLiteStore();t.after(()=>store.close());let streams=0;
 const llm: LLM={async *stream(){streams++;yield {kind:'reasoning',payload:{delta:'retained'}};yield {kind:'text',payload:{text:'{"tool_calls":[{"name":"write","arguments":{}}]}'}};}};
 const app=new Application(store,llm,policy,undefined,{harness:store,tools:{catalog:()=>'',execute:async()=>{throw new ToolError('not allowed');}}});
 assert.match((await app.handle(message))!.text,/write.*blocked:.*not allowed/);
 assert.equal(streams,1);assert.equal((await store.harnessState('s','m'))?.kind,'ToolResultsHeld');
});
test('stream interruption preserves partial events and resumes on an explicit retry',async t=>{
 const store=new SQLiteStore();t.after(()=>store.close());let notify!:()=>void;
 const started=new Promise<void>(resolve=>{notify=resolve;});let runs=0;
 const llm:LLM={async *stream(_prompt,signal){runs++;yield {kind:'reasoning',payload:{delta:'partial reasoning'}};yield {kind:'text',payload:{text:'partial'}};
  if(runs===2) assert.ok(_prompt.inputs.some(item=>item.content.includes('incomplete_assistant_response')&&item.content.includes('partial')));
  if(runs===1){notify();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));signal!.throwIfAborted();}
  yield {kind:'text',payload:{text:' complete'}};
 }};
 const app=new Application(store,llm,policy,undefined,{harness:store});
 const pending=app.handle(message);await started;
 assert.equal(await app.interrupt('elsewhere','m'),false);
 assert.equal(await app.interrupt('s','m'),true);
 await assert.rejects(pending,HarnessInterrupted);
 assert.equal((await store.harnessState('s','m'))?.kind,'StreamingInterrupted');
 assert.equal(await store.partialReply(message),'partial');
 assert.equal((await app.handle(message,true))?.text,'partial complete');
 assert.equal((await store.harnessState('s','m'))?.kind,'WaitingForUserMessage');
});
test('uncertain writes remain journaled and are not repeated on restored tool phases',async t=>{
 const store=new SQLiteStore();t.after(()=>store.close());let writes=0;
 const tools=new ToolRegistry(store,async()=>true);
 tools.register({name:'write',description:'write',fields:{},access:'member',effect:'write',retrySafe:false,execute:async()=>{writes++;throw new Error('connection lost after writing');}});
 const llm:LLM={async *stream(){yield {kind:'text',payload:{text:'{"tool_calls":[{"name":"write","arguments":{}}]}'}};}};
 const app=new Application(store,llm,policy,undefined,{harness:store,tools:{catalog:()=>tools.catalog(),execute:(m,c,id)=>tools.invokeResult(m,c.name,c.arguments,id,'agent')}});
 await assert.rejects(app.handle(message),UncertainActionError);
 assert.equal((await store.harnessState('s','m'))?.kind,'ToolPhase');
 await assert.rejects(app.handle(message,true),UncertainActionError);
 assert.equal(writes,1);
});

test('provider failures persist a resumable state and partial output',async t=>{
 const store=new SQLiteStore();t.after(()=>store.close());
 const app=new Application(store,{async *stream(){yield {kind:'reasoning',payload:{delta:'reasoning'}};yield {kind:'text',payload:{text:'partial response'}};throw Error('provider failed');}},policy,undefined,{harness:store});
 await assert.rejects(app.handle(message),/provider failed/);
 assert.equal((await store.harnessState('s','m'))?.kind,'StreamingFailed');
 assert.equal(await store.partialReply(message),'partial response');
 await store.revise({...message,text:'edited request'});
 assert.equal(await store.partialReply({...message,text:'edited request'}),undefined);
});
test('provider cancellation signal reaches the HTTP adapter',async()=>{
 const {ChatCompletionsLLM}=await import('../src/adapters/chat-completions.js');
 const controller=new AbortController();controller.abort();
 const llm=new ChatCompletionsLLM({baseUrl:'https://example.test',model:'test',apiKey:'test'},async(_input,init)=>{assert.ok(init?.signal?.aborted);init!.signal!.throwIfAborted();throw Error('unreachable');});
 await assert.rejects(async()=>{for await (const _event of llm.stream({prefixVersion:'v',prefix:[],history:[],inputs:[]},controller.signal)){};});
});

test('restart between tool completion and turn commit reuses the journaled result',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const directory=mkdtempSync(join(tmpdir(),'slopbot-harness-'));const path=join(directory,'store.sqlite3');
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let writes=0,store=new SQLiteStore(path);
 const registry=()=>{const tools=new ToolRegistry(store,async()=>true);tools.register({name:'write',description:'write',fields:{},access:'member',effect:'write',retrySafe:false,execute:async()=>{writes++;return {text:'confirmed write'};}});return tools;};
 let tools=registry();
 const first=new Application(store,{async *stream(){yield {kind:'text',payload:{text:'{"tool_calls":[{"name":"write","arguments":{}}]}'}};}},policy,undefined,{harness:store,tools:{catalog:()=>tools.catalog(),execute:async(m,c,id)=>{await tools.invokeResult(m,c.name,c.arguments,id,'agent');throw Error('process lost before turn commit');}}});
 await assert.rejects(first.handle(message),/process lost/);assert.equal(writes,1);
 store.close();store=new SQLiteStore(path);t.after(()=>store.close());store.recoverJobs('s');tools=registry();
 const resumed=new Application(store,{async *stream(){yield {kind:'text',payload:{text:'finished'}};}},policy,undefined,{harness:store,tools:{catalog:()=>tools.catalog(),execute:(m,c,id)=>tools.invokeResult(m,c.name,c.arguments,id,'agent')}});
 assert.equal((await resumed.handle(message,true))?.text,'finished');assert.equal(writes,1);
 assert.equal((await store.harnessState('s','m'))?.kind,'WaitingForUserMessage');
});
