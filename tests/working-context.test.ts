import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Application } from '../src/application.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ByteTokenCounter } from '../src/context.js';
import { wireMessages } from '../src/adapters/chat-completions.js';
import { RequestError } from '../src/errors.js';
import { appendToolEvidence } from '../src/prompt-cache.js';
import type { Prompt, ModelTool } from '../src/domain.js';
const schema: ModelTool = {type:'function',function:{name:'lookup',description:'Read state',parameters:{type:'object',properties:{step:{type:'integer'}},required:['step']}}};
const checkpoint = '{"goal":"finish the task","constraints":[],"decisions":[],"disagreements":[],"progress":["Earlier reads completed; keep their recorded results."],"artifacts":[],"pending_actions":[]}';
const message = {server:'s',channel:'t',taskId:'t',author:'alice',id:'request',text:'Finish the task',addressed:true};

test('long active native-tool loops checkpoint complete pairs and retain original results', async t => {
  const store = new SQLiteStore(); t.after(()=>store.close());
  const prompts: Prompt[] = []; let rounds = 0, reads = 0, checkpoints = 0;
  const counter = new ByteTokenCounter();
  const app = new Application(store,{async *stream(prompt){
    prompts.push(prompt);
    if(prompt.purpose === 'checkpoint'){assert.ok(prompt.maxOutputTokens! > 1024 && prompt.maxOutputTokens! <= 8192);checkpoints++;yield {kind:'text',payload:{text:checkpoint}};return;}
    const items=wireMessages(prompt);
    for(const [index,item] of items.entries()) if(item.tool_calls) {
      assert.ok(items.slice(index+1,index+1+item.tool_calls.length).every(result=>result.role==='tool'));
    }
    if(++rounds<=8) yield {kind:'tool_call',payload:[{id:`call_${rounds}`,name:'lookup',arguments:{step:rounds}}]};
    else yield {kind:'text',payload:{text:'Finished all eight reads.'}};
  }},{allowedChannels:[{server:'s',channel:'t'}],maxInputChars:8000,maxOutputTokens:1024,checkpointTokens:1024},undefined,
  {harness:store,tools:{catalog:()=>'',schemas:()=>[schema],execute:async()=>{reads++;return {text:`Read ${reads} completed. `+'x'.repeat(4000)};}}});
  const reply=await app.handle(message);
  assert.equal(reply?.text,'Finished all eight reads.'); assert.equal(reads,8); assert.ok(checkpoints>0);
  for(const prompt of prompts) {
    const schemas=prompt.tools?counter.count([{role:'system',content:JSON.stringify(prompt.tools)}]):0;
    assert.ok(counter.count([...prompt.prefix,...prompt.history,...prompt.inputs])+schemas<=8000);
  }
  assert.equal(store.agentTurns(message).length,8);
  for(const turn of store.agentTurns(message)) assert.ok((turn.results['0'] as {text:string}).text.length>4000);
  assert.ok(store.historyArchive(JSON.stringify(['s','t','t'])).some(item=>item.content.includes('working_checkpoint')));
});

test('history is checkpointed before selection so the first successful tool has working space', async t => {
  const store = new SQLiteStore(); t.after(()=>store.close()); let main = 0, reads = 0, checkpoints = 0;
  const app = new Application(store,{async *stream(prompt){
    if(prompt.purpose==='checkpoint'){checkpoints++;yield {kind:'text',payload:{text:checkpoint}};return;}
    main++;
    if(main===1) yield {kind:'text',payload:{text:'Previous task evidence: '+'h'.repeat(6000)}};
    else if(main===2) yield {kind:'tool_call',payload:[{id:'call_profile',name:'lookup',arguments:{step:1}}]};
    else yield {kind:'text',payload:{text:'Profile checked.'}};
  }},{allowedChannels:[{server:'s',channel:'t'}],maxInputChars:8000,maxOutputTokens:1024,checkpointTokens:1024},undefined,
  {tools:{catalog:()=>'',schemas:()=>[schema],execute:async()=>{reads++;return 'Profile: alice. '+'p'.repeat(2000);}}});
  await app.handle({...message,id:'earlier',text:'Earlier task'});
  const reply=await app.handle(message);
  assert.equal(reply?.text,'Profile checked.'); assert.equal(reads,1); assert.ok(checkpoints>0);
});

test('a tool result that cannot fit has a specific code and budget figures', () => {
  assert.throws(()=>appendToolEvidence('lookup',{text:'result'},[{role:'user',content:'x'.repeat(100)}],new ByteTokenCounter(),50),error=>{
    assert.ok(error instanceof RequestError);assert.equal(error.code,'CONTEXT_BUDGET');
    assert.ok(Number(error.details.required)>50);assert.equal(error.details.inputLimit,50);return true;
  });
});


test('restart reconstructs checkpointed rounds without executing completed tools again', async t => {
  const store=new SQLiteStore();t.after(()=>store.close());let reads=0,requests=0,failed=false;
  const llm: import('../src/ports.js').LLM={async *stream(prompt){
    if(prompt.purpose==='checkpoint'){yield {kind:'text',payload:{text:checkpoint}};return;}
    requests++;
    if(reads===4 && !failed){failed=true;throw new TypeError('temporary stream failure');}
    if(reads<8)yield {kind:'tool_call',payload:[{id:`call_${reads+1}`,name:'lookup',arguments:{step:reads+1}}]};
    else yield {kind:'text',payload:{text:'Recovered and finished.'}};
  }};
  const policy={allowedChannels:[{server:'s',channel:'t'}],maxInputChars:8000,maxOutputTokens:1024,checkpointTokens:1024};
  const services={harness:store,tools:{catalog:()=>'',schemas:()=>[schema],execute:async()=>{reads++;return {text:'Completed read '+reads+'x'.repeat(4000)};}}};
  await assert.rejects(new Application(store,llm,policy,undefined,services).handle(message),/temporary stream failure/);
  assert.equal(reads,4);
  const reply=await new Application(store,llm,policy,undefined,services).handle(message,true);
  assert.equal(reply?.text,'Recovered and finished.');assert.equal(reads,8);assert.equal(store.agentTurns(message).length,8);
  assert.equal(reply?.toolActivity?.filter(item=>item.reused).length,4);assert.ok(requests>8);
});
