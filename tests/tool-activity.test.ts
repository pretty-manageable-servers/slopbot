import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolFooter, toolProgress, toolDisplayMode } from '../src/presentation/tool-activity.js';
import { DiscordToolProgress } from '../src/adapters/discord-tool-progress.js';
import { Application } from '../src/application.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolError } from '../src/tools.js';
import type { ToolActivity } from '../src/tool-activity.js';

test('summary footer counts calls by tool with plural forms and no durations', () => {
  const calls: ToolActivity[] = [
    {id:'1',name:'web_search',status:'completed',durationMs:1200},
    {id:'2',name:'web_search',status:'completed',durationMs:2700},
    {id:'3',name:'web_search',status:'completed',reused:true},
    {id:'4',name:'history_search',status:'completed',arguments:{query:'deploy'}},
  ];
  assert.equal(toolFooter(calls, 'summary'), '\n\n-# 🔎 3 web searches · 📜 1 history search');
  assert.equal(toolFooter(calls), '\n\n-# 🔎 3 web searches · 📜 1 history search');
  assert.match(toolProgress(calls, 'Blooming…'), /🔎 Web search × 3\n📜 History search × 1/);
});

test('full footer shows counts and only the blocked calls', () => {
  assert.equal(toolFooter([]), '');
  const calls: ToolActivity[] = [
    {id:'1',name:'web_search',status:'completed'},
    {id:'2',name:'web_search',status:'completed'},
    {id:'3',name:'index',status:'rejected'},
    {id:'4',name:'index',status:'completed',reused:true},
  ];
  assert.equal(toolFooter(calls), '\n\n-# 🔎 2 web searches · 🛠️ 2 index\n-# ❌ index blocked');
  assert.match(toolProgress(calls, 'Blooming…'), /🔎 Web search × 2/);
});

test('tool errors retain distinct reasons and render them as bounded plain text', () => {
  const calls: ToolActivity[] = [
    {id:'1',name:'index',status:'rejected',reason:'Missing argument: channel'},
    {id:'2',name:'index',status:'rejected',reason:'Manage Server permission is required.'},
    {id:'3',name:'remote_read',status:'failed',reason:'Service unavailable'},
    {id:'4',name:'read',status:'rejected',reason:'Bad\n**input** <@123> ' + 'x'.repeat(1000)},
  ];
  const footer = toolFooter(calls);
  assert.match(footer, /-# ❌ index blocked: Missing argument: channel/);
  assert.match(footer, /-# ❌ index blocked: Manage Server permission is required/);
  assert.match(footer, /-# ❌ remote read failed: Service unavailable/);
  assert.ok(!footer.includes('×2'));
  assert.ok(!footer.includes('Bad\n'));
  assert.ok(!footer.includes('<@123>'));
  assert.ok(footer.length < 900);
  assert.match(toolProgress(calls, 'Blooming…'), /-# ❌ remote read failed: Service unavailable/);
});

for (const returned of [false, true]) test(`runner explains execution failures from ${returned ? 'results' : 'exceptions'} and lets the model explain the failure`, async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let rounds = 0;
  const app = new Application(store, {async *stream(){rounds++;yield {kind:'text',payload:{text:rounds === 1 ? '{"tool_calls":[{"name":"remote_read","arguments":{}}]}' : 'The remote service is unavailable.'}};}},
    {allowedChannels:[{server:'s',channel:'c'}]}, undefined,
    {harness:store,tools:{catalog:()=>'',execute:async()=>{
      if (returned) return {text:'Remote service unavailable',status:'failed',reason:'Remote service unavailable'};
      throw new ToolError('Remote service unavailable', 'failed');
    }}});
  const reply = await app.handle({server:'s',channel:'c',author:'person',id:'request',text:'Read it',addressed:true});
  assert.equal(rounds, 2);
  assert.equal(reply!.text, 'The remote service is unavailable.');
  assert.equal(reply!.toolActivity![0]!.status, 'failed');
  assert.match(reply!.toolActivity![0]!.reason ?? '', /Remote service unavailable/);
  assert.equal((await store.harnessState('s', 'request'))?.kind, 'WaitingForUserMessage');
});

test('progress edits one message per request and removes it after delivery', async () => {
  const progress = new DiscordToolProgress(() => 0);
  const sent: string[] = [], edited: string[] = [];
  let deleted = 0;
  const send = async (text: string) => {sent.push(text);return {async edit(content: string){edited.push(content);},async delete(){deleted++;}};};
  await progress.update('request', {id:'1',name:'web_search',status:'running'},send);
  await progress.update('request', {id:'1',name:'web_search',status:'completed'},send);
  await progress.update('other', {id:'2',name:'index',status:'running'},send);
  assert.equal(sent.length,2);
  assert.deepEqual(edited,['<a:slopbot_pulse:1559390627152531586> Watering the petals…\n🔎 Web search × 1\n-# now: 🔎 web_search']);
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
    const app = new Application(store, {async *stream(){yield {kind:'text',payload:{text:++rounds === 1 ? '{"tool_calls":[{"name":"web_search","arguments":{"query":"weather"}}]}' : 'Answer'}};}},
      {allowedChannels:[{server:'s',channel:'c'}]}, undefined,
      {onToolActivity:async (_message,event)=>{events.push(event);},tools:{catalog:()=>'',execute:async()=>{if(rejected)throw new ToolError('Unavailable');return 'Search results';}}});
    const reply = await app.handle({server:'s',channel:'c',author:'person',id:'request',text:'Find information',addressed:true});
    assert.deepEqual(events.map(event=>event.status),['running',rejected ? 'rejected' : 'completed']);
    assert.equal(reply?.toolActivity?.length,1);
    assert.deepEqual(events[0]?.arguments, {query:'weather'});
    assert.deepEqual(reply?.toolActivity?.[0]?.arguments, {query:'weather'});
    assert.equal(reply?.toolActivity?.[0]?.status,rejected ? 'rejected' : 'completed');
    assert.equal(reply?.toolActivity?.[0]?.reused,false);
    if (rejected) { assert.match(reply?.toolActivity?.[0]?.reason ?? '', /Unavailable/); assert.equal(reply!.text, 'Answer'); }
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

 test('progress stays within Discord limits with eight long failures', () => {
 const items: ToolActivity[] = Array.from({length:8},(_,i)=>({id:String(i),name:'read_'+i,status:'failed',reason:'x'.repeat(500)}));
 const text = toolProgress(items, 'Blooming…'); assert.ok(text.length <= 2000); for(const item of items.slice(-3)) assert.ok(text.includes(item.name.replace('_', ' ') + ' failed'));
 });


test('completed replies support hidden, grouped, and expanded tool activity', () => {
  const calls: ToolActivity[] = [
    {id:'1',name:'web_search',status:'completed',durationMs:100,arguments:{query:'weather'}},
    {id:'2',name:'web_search',status:'completed',durationMs:200,arguments:{query:'traffic'}},
    {id:'3',name:'sandbox',status:'failed',arguments:{command:'ls'},reason:'Unavailable'},
  ];
  assert.equal(toolFooter(calls, 'none'), '');
  assert.equal(toolFooter(calls, 'summary'), '\n\n-# 🔎 2 web searches · 💻 1 sandbox');
  const full = toolFooter(calls, 'full');
  assert.equal(full, '\n\n-# 🔎 2 web searches · 💻 1 sandbox\n-# ❌ sandbox failed: Unavailable');
  assert.ok(!full.includes('weather') && !full.includes('```'));
  assert.equal(toolDisplayMode(undefined), 'summary');
  assert.equal(toolDisplayMode('invalid'), 'summary');
  assert.equal(toolDisplayMode('none'), 'none');
  assert.equal(toolDisplayMode('full'), 'full');
});

test('live progress is bounded, escapes the query and never shows JSON or secrets', () => {
  const calls: ToolActivity[] = Array.from({length:10}, (_, i) => ({
    id:String(i),name:'read',status:'running',reason:'oops '.repeat(200),
    arguments:{query:'``` <@123> '.repeat(200), api_key:'private-value', nested:{password:'private-value'}},
  }));
  const progress = toolProgress(calls, 'Blooming…');
  assert.ok(progress.length <= 2000);
  assert.ok(!progress.includes('```') && !progress.includes('json') && !progress.includes('private-value'));
  assert.match(progress, /^-# now: 🛠️ "/m);
  const full = toolFooter(calls, 'full');
  assert.ok(!full.includes('private-value') && !full.includes('```') && !full.includes('json'));
});

test('the now line uses the tool emoji and a clipped, escaped query', () => {
  const long = 'rbc *interview* loop ' + 'x'.repeat(80);
  const calls: ToolActivity[] = [{id:'1',name:'web_search',status:'running',arguments:{query:long}}];
  const progress = toolProgress(calls, 'Blooming…');
  assert.match(progress, /^-# now: 🔎 "rbc \\\*interview\\\* loop x+…"$/m);
});

test('20 calls of 5 tool types stay under the Discord limit', () => {
  const names = ['web_search', 'history_search', 'history_read', 'file_read', 'index'];
  const calls: ToolActivity[] = Array.from({length:20}, (_, i) => ({
    id:String(i),name:names[i % 5]!,status:i % 3 === 0 ? 'failed' : 'completed',reason:'x'.repeat(300),arguments:{query:'q'.repeat(200)},
  }));
  const progress = toolProgress(calls, 'Blooming…');
  assert.ok(progress.length <= 2000);
  assert.equal(progress.split('\n').filter(line => line.startsWith('-# ❌')).length, 3);
});

test('progress and footer have no JSON code blocks', () => {
  const calls: ToolActivity[] = [{id:'1',name:'web_search',status:'failed',reason:'Down',arguments:{query:'weather'}}];
  assert.ok(!toolProgress(calls, 'Blooming…').includes('```json'));
  assert.ok(!toolFooter(calls, 'full').includes('```json'));
});

test('parallel child events send a single status message and cleanup waits for updates', async () => {
  const progress = new DiscordToolProgress();
  let sent = 0, deleted = false;
  const edits: string[] = [];
  const send = async () => {
    sent++;
    await new Promise(resolve => setImmediate(resolve));
    return {async edit(content: string) {assert.equal(deleted, false); edits.push(content);}, async delete() {deleted = true;}};
  };
  await Promise.all([
    progress.update('request', {id:'1',name:'read_one',status:'running'}, send),
    progress.update('request', {id:'2',name:'read_two',status:'running'}, send),
    progress.finish('request'),
  ]);
  assert.equal(sent, 1);
  assert.match(edits[0]!, /Read one × 1/);
  assert.match(edits[0]!, /Read two × 1/);
  assert.equal(deleted, true);
});

test('progress changes the fun line on every update', async () => {
  const progress = new DiscordToolProgress(() => 0);
  const lines: string[] = [];
  const send = async (text: string) => {
    lines.push(text.split('\n')[0]!);
    return {async edit(content: string) {lines.push(content.split('\n')[0]!);}, async delete() {}};
  };
  for (let i = 0; i < 4; i++) await progress.update('request', {id:String(i),name:'web_search',status:'completed'}, send);
  assert.equal(lines.length, 4);
  for (let i = 1; i < lines.length; i++) assert.notEqual(lines[i], lines[i - 1]);
});
