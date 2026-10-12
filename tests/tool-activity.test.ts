import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolFooter, toolProgress } from '../src/presentation/tool-activity.js';
import { DiscordToolProgress } from '../src/adapters/discord-tool-progress.js';
import { Application } from '../src/application.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolError } from '../src/tools.js';
import type { ToolActivity } from '../src/tool-activity.js';

test('each timed call is displayed separately, with no invented duration for saved results', () => {
  const calls: ToolActivity[] = [
    {id:'1',name:'web_search',status:'completed',durationMs:1200},
    {id:'2',name:'web_search',status:'completed',durationMs:2700},
    {id:'3',name:'web_search',status:'completed',reused:true},
  ];
  assert.match(toolFooter(calls), /`web_search`: completed \| 1.2s\n- `web_search`: completed \| 2.7s/);
  assert.match(toolProgress(calls), /2\. `web_search`: completed \| 2.7s/);
  assert.ok(toolFooter(calls).endsWith('`web_search`: completed, saved result'));
});

test('tool footer groups repeated calls and distinguishes rejected and saved results', () => {
  assert.equal(toolFooter([]), '');
  const calls: ToolActivity[] = [
    {id:'1',name:'web_search',status:'completed'},
    {id:'2',name:'web_search',status:'completed'},
    {id:'3',name:'index',status:'rejected'},
    {id:'4',name:'index',status:'completed',reused:true},
  ];
  assert.equal(toolFooter(calls), '\n\n**Tool activity**\n- `web_search` ×2: completed\n- `index`: blocked\n- `index`: completed, saved result');
  assert.match(toolProgress(calls), /1\. `web_search`: completed/);
});

test('tool errors retain distinct reasons and render them as bounded plain text', () => {
  const calls: ToolActivity[] = [
    {id:'1',name:'index',status:'rejected',reason:'Missing argument: channel'},
    {id:'2',name:'index',status:'rejected',reason:'Manage Server permission is required.'},
    {id:'3',name:'remote_read',status:'failed',reason:'Service unavailable'},
    {id:'4',name:'read',status:'rejected',reason:'Bad\n**input** <@123> ' + 'x'.repeat(1000)},
  ];
  const footer = toolFooter(calls);
  assert.match(footer, /index`: blocked: Missing argument: channel/);
  assert.match(footer, /index`: blocked: Manage Server permission is required/);
  assert.match(footer, /remote_read`: failed: Service unavailable/);
  assert.ok(!footer.includes('×2'));
  assert.ok(!footer.includes('Bad\n'));
  assert.ok(!footer.includes('<@123>'));
  assert.ok(footer.length < 900);
  assert.match(toolProgress(calls), /remote_read`: failed: Service unavailable/);
});

for (const returned of [false, true]) test(`runner explains execution failures from ${returned ? 'results' : 'exceptions'} and holds continuation`, async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let rounds = 0;
  const app = new Application(store, {async *stream(){rounds++;yield {kind:'text',payload:{text:'{"tool_calls":[{"name":"remote_read","arguments":{}}]}'}};}},
    {allowedChannels:[{server:'s',channel:'c'}]}, undefined,
    {harness:store,tools:{catalog:()=>'',execute:async()=>{
      if (returned) return {text:'Remote service unavailable',status:'failed',reason:'Remote service unavailable'};
      throw new ToolError('Remote service unavailable', 'failed');
    }}});
  const reply = await app.handle({server:'s',channel:'c',author:'person',id:'request',text:'Read it',addressed:true});
  assert.equal(rounds, 1);
  assert.match(reply!.text, /remote_read.*failed: Remote service unavailable/);
  assert.equal(reply!.toolActivity![0]!.status, 'failed');
  assert.equal(reply!.toolActivity![0]!.reason, 'Remote service unavailable');
  assert.equal((await store.harnessState('s', 'request'))?.kind, 'ToolResultsHeld');
});

test('progress edits one message per request and removes it after delivery', async () => {
  const progress = new DiscordToolProgress();
  const sent: string[] = [], edited: string[] = [];
  let deleted = 0;
  const send = async (text: string) => {sent.push(text);return {async edit(content: string){edited.push(content);},async delete(){deleted++;}};};
  await progress.update('request', {id:'1',name:'web_search',status:'running'},send);
  await progress.update('request', {id:'1',name:'web_search',status:'completed'},send);
  await progress.update('other', {id:'2',name:'index',status:'running'},send);
  assert.equal(sent.length,2);
  assert.deepEqual(edited,['**Working**\n1. `web_search`: completed']);
  await progress.finish('request');
  assert.equal(deleted,1);
  await progress.update('other', {id:'2',name:'index',status:'completed'},send);
  assert.equal(sent.length,2);
});

for (const rejected of [false,true]) test(`execution reports ${rejected ? 'rejection' : 'completion'} independently of the model`, async () => {
  const store = new SQLiteStore();
  const events: ToolActivity[] = [];
  let rounds = 0;
  try {
    const app = new Application(store, {async *stream(){yield {kind:'text',payload:{text:++rounds === 1 ? '{"tool_calls":[{"name":"web_search","arguments":{}}]}' : 'Answer'}};}},
      {allowedChannels:[{server:'s',channel:'c'}]}, undefined,
      {onToolActivity:async (_message,event)=>{events.push(event);},tools:{catalog:()=>'',execute:async()=>{if(rejected)throw new ToolError('Unavailable');return 'Search results';}}});
    const reply = await app.handle({server:'s',channel:'c',author:'person',id:'request',text:'Find information',addressed:true});
    assert.deepEqual(events.map(event=>event.status),['running',rejected ? 'rejected' : 'completed']);
    assert.equal(reply?.toolActivity?.length,1);
    assert.equal(reply?.toolActivity?.[0]?.status,rejected ? 'rejected' : 'completed');
    assert.equal(reply?.toolActivity?.[0]?.reused,false);
    if (rejected) { assert.equal(reply?.toolActivity?.[0]?.reason, 'Unavailable'); assert.match(reply!.text, /web_search.*blocked: Unavailable/); }
    assert.ok(Number.isFinite(reply?.toolActivity?.[0]?.durationMs));
    assert.ok(!reply?.text.includes('Tool activity'));
  } finally {store.close();}
});

test('a failed status display does not prevent tool execution', async () => {
  const store = new SQLiteStore();
  let executed = false;
  try {
    const app = new Application(store,{async *stream(){yield {kind:'text',payload:{text:'unused'}};}},
      {allowedChannels:[{server:'s',channel:'c'}]},undefined,
      {onToolActivity:async()=>{throw new Error('Discord unavailable');},tools:{catalog:()=>'',suggest:()=>({name:'read',arguments:{}}),execute:async()=>{executed=true;return 'Confirmed';}}});
    const reply = await app.handle({server:'s',channel:'c',author:'person',id:'request',text:'Check status',addressed:true});
    assert.equal(executed,true);
    assert.equal(reply?.toolActivity?.[0]?.status,'completed');
  } finally {store.close();}
});
