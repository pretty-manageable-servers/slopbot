import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolFooter, toolProgress, toolDisplayMode } from '../src/presentation/tool-activity.js';
import { DiscordToolProgress } from '../src/adapters/discord-tool-progress.js';
import { Application } from '../src/application.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolError } from '../src/tools.js';
import { RequestError } from '../src/errors.js';
import type { ToolActivity } from '../src/tool-activity.js';

test('summary footer counts calls by tool with plural forms and no durations', () => {
  const calls: ToolActivity[] = [
    {id:'1',name:'web_search',status:'completed',durationMs:1200},
    {id:'2',name:'web_search',status:'completed',durationMs:2700},
    {id:'3',name:'web_search',status:'completed',reused:true},
    {id:'4',name:'history_search',status:'completed',arguments:{query:'deploy'}},
  ];
  assert.equal(toolFooter(calls, 'summary'), '\n\n-# searched the web 3× · searched history');
  assert.equal(toolFooter(calls), '\n\n-# searched the web 3× · searched history');
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
  assert.equal(toolFooter(calls), '\n\n-# searched the web 2× · used index · 1 blocked');
  assert.match(toolProgress(calls, 'Blooming…'), /🔎 Web search × 2/);
});

test('unfinished writes are not counted as completed and their interrupted run reports an unknown outcome', async t => {
  const calls: ToolActivity[] = [{ id: 'write', name: 'file_store', status: 'running' }, { id: 'read', name: 'file_read', status: 'completed' }];
  const footer = toolFooter(calls, 'summary');
  assert.match(footer, /outcome unknown/); assert.ok(!footer.includes('1 file store'));
  const store = new SQLiteStore(); t.after(() => store.close()); const events: ToolActivity[] = [];
  const app = new Application(store, { async *stream() { yield { kind: 'tool_call', payload: [{ name: 'file_store', arguments: {} }] }; } }, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined,
    { harness: store, onToolActivity: async (_message, event) => { events.push(event); }, tools: { schemas: () => [], catalog: () => '', execute: async () => { throw new RequestError('CONTEXT_BUDGET', 'Interrupted before the result was saved', 'Inspect the journal'); } } });
  await assert.rejects(app.handle({ server: 's', channel: 'c', author: 'a', id: 'unknown', text: 'save file', addressed: true }), /Tool outcome unknown/);
  assert.equal(events.at(-1)?.status, 'failed'); assert.match(events.at(-1)?.reason ?? '', /no confirmed result/);
  assert.deepEqual((await store.agentTurns({ server: 's', channel: 'c', author: 'a', id: 'unknown', text: '' }))[0]?.results, {});
});

test('tool errors retain distinct reasons and render them as bounded plain text', () => {
  const calls: ToolActivity[] = [
    {id:'1',name:'index',status:'rejected',reason:'Missing argument: channel'},
    {id:'2',name:'index',status:'rejected',reason:'Manage Server permission is required.'},
    {id:'3',name:'remote_read',status:'failed',reason:'Service unavailable'},
    {id:'4',name:'read',status:'rejected',reason:'Bad\n**input** <@123> ' + 'x'.repeat(1000)},
  ];
  // The footer is one line of counts. The reasons are in the progress trace.
  const footer = toolFooter(calls);
  assert.equal(footer, '\n\n-# 3 blocked · 1 failed');
  assert.ok(!footer.includes('Bad\n'));
  assert.ok(!footer.includes('<@123>'));
  assert.ok(footer.length < 900);
  assert.match(toolProgress(calls, 'Blooming…'), /-# ❌ remote read failed: Service unavailable/);
  assert.match(toolProgress(calls, 'Blooming…'), /-# ❌ index blocked: Manage Server permission is required/);
});

for (const returned of [false, true]) test(`runner explains execution failures from ${returned ? 'results' : 'exceptions'} and lets the model explain the failure`, async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let rounds = 0;
  const app = new Application(store, {async *stream(){rounds++;yield rounds === 1 ? {kind:'tool_call',payload:[{name:'remote_read',arguments:{}}]} : {kind:'text',payload:{text:'The remote service is unavailable.'}};}},
    {allowedChannels:[{server:'s',channel:'c'}]}, undefined,
    {harness:store,tools:{schemas: () => [], catalog:()=>'',execute:async()=>{
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
  assert.deepEqual(edited,['<a:slopbot_pulse:1559390627152531586> Baking…\n🔎 Web search × 1\n-# now: 🔎 web_search']);
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
    const app = new Application(store, {async *stream(){yield ++rounds === 1 ? {kind:'tool_call',payload:[{name:'web_search',arguments:{query:'weather'}}]} : {kind:'text',payload:{text:'Answer'}};}},
      {allowedChannels:[{server:'s',channel:'c'}]}, undefined,
      {onToolActivity:async (_message,event)=>{events.push(event);},tools:{schemas: () => [], catalog:()=>'',execute:async()=>{if(rejected)throw new ToolError('Unavailable');return 'Search results';}}});
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
      {onToolActivity:async()=>{throw new Error('Discord unavailable');},tools:{schemas: () => [], catalog:()=>'',suggest:()=>({name:'read',arguments:{}}),execute:async()=>{executed=true;return 'Confirmed';}}});
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
    {id:'3',name:'shell',status:'failed',arguments:{command:'ls'},reason:'Unavailable'},
  ];
  assert.equal(toolFooter(calls, 'none'), '');
  assert.equal(toolFooter(calls, 'summary'), '\n\n-# searched the web 2× · 1 failed');
  const full = toolFooter(calls, 'full');
  assert.equal(full, '\n\n-# searched the web 2× · 1 failed');
  assert.ok(!full.includes('weather') && !full.includes('```'));
  assert.equal(toolDisplayMode(undefined), 'summary');
  assert.equal(toolDisplayMode('invalid'), 'summary');
  assert.equal(toolDisplayMode('none'), 'none');
  assert.equal(toolDisplayMode('full'), 'full');
});

test('live progress is bounded, escapes the query and never shows JSON or secrets', () => {
  const calls: ToolActivity[] = Array.from({length:10}, (_, i) => ({
    id:String(i),name:'custom_tool',status:'running',reason:'oops '.repeat(200),
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
  const names = ['web_search', 'history_search', 'history_read', 'read', 'index'];
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

test('footer total time spans first tool start to last tool end', () => {
  const calls: ToolActivity[] = [
    {id:'1',name:'web_search',status:'completed',startedAt:1000,durationMs:2000},
    {id:'2',name:'web_search',status:'completed',startedAt:1500,durationMs:4000},
    {id:'3',name:'history_search',status:'completed',startedAt:40000,durationMs:3000},
  ];
  assert.equal(toolFooter(calls, 'summary'), '\n\n-# searched the web 2× · searched history · 42s');
});

test('programmatic progress renders actual child states and durations in a closed plain code block', () => {
  const calls: ToolActivity[] = [
    {id:'run', name:'run_tools_code', status:'running', code:'secret code'},
    {id:'1', parentId:'run', name:'web_search', status:'completed', durationMs:1200},
    {id:'2', parentId:'run', name:'history_search', status:'completed', durationMs:400},
    {id:'3', parentId:'run', name:'history_read', status:'running', arguments:{query:'secret query'}},
  ];
  assert.equal(toolProgress(calls, 'Blooming…'), '<a:slopbot_pulse:1559390627152531586> Blooming…\nRun 1 · running\n```\n┌ ✓ web_search · 1.2s\n│ ✓ history_search · 0.4s\n│ ◌ history_read · running\n└ 2 completed · 1 running\n```');
});

test('code-only execution and completed, failed, blocked and reused children have honest states', () => {
  const run: ToolActivity = {id:'run', name:'run_tools_code', status:'running'};
  assert.match(toolProgress([run], 'Blooming…'), /┌ ◌ running\n└ 0 tool calls/);
  assert.match(toolProgress([{...run, status:'completed'}], 'Blooming…'), /Run 1 · completed\n```\n┌ ✓ completed/);
  const calls: ToolActivity[] = [run,
    {id:'1', parentId:'run', name:'read', status:'failed', durationMs:200},
    {id:'2', parentId:'run', name:'write', status:'rejected', durationMs:300},
    {id:'3', parentId:'run', name:'web_search', status:'completed', reused:true, durationMs:10},
  ];
  const text = toolProgress(calls, 'Blooming…');
  assert.match(text, /× read · 0.2s · failed/);
  assert.match(text, /! write · 0.3s · blocked/);
  assert.match(text, /✓ web_search · 0.0s · saved result/);
  assert.match(text, /└ 1 failed · 1 blocked · 1 completed/);
});

test('many code runs preserve complete fences, accurate totals and active calls within Discord limits', () => {
  const calls: ToolActivity[] = [];
  for (let run = 0; run < 8; run++) {
    calls.push({id:`run${run}`, name:'run_tools_code', status:run === 7 ? 'running' : 'completed'});
    for (let child = 0; child < 64; child++) calls.push({
      id:`${run}-${child}`, parentId:`run${run}`, name:child >= 60 ? `active_${child}` : 'tool_' + 'x'.repeat(100),
      status:child >= 60 ? 'running' : 'completed', durationMs:1200,
    });
  }
  const text = toolProgress(calls, 'Blooming…');
  assert.ok(text.length <= 2000);
  assert.equal((text.match(/```/g) ?? []).length, 6);
  assert.ok(text.endsWith('```'));
  assert.match(text, /5 earlier code runs in tool trace/);
  assert.match(text, /Run 8 · running/);
  assert.match(text, /more calls in tool trace/);
  assert.match(text, /└ 60 completed · 4 running/);
  for (let child = 60; child < 64; child++) assert.match(text, new RegExp(`◌ active_${child} · running`));
});

test('programmatic child updates edit the same message and stay under their own code run', async () => {
  const progress = new DiscordToolProgress(() => 0);
  const messages: string[] = [];
  let sent = 0;
  const send = async (text: string) => {
    sent++; messages.push(text);
    return {async edit(content: string) {messages.push(content);}, async delete() {}};
  };
  await progress.update('request', {id:'run', name:'run_tools_code', status:'running'}, send);
  await progress.update('request', {id:'child', parentId:'run', name:'web_search', status:'running'}, send);
  await progress.update('request', {id:'child', parentId:'run', name:'web_search', status:'completed', durationMs:1200}, send);
  await progress.update('request', {id:'run', name:'run_tools_code', status:'completed'}, send);
  await progress.update('request', {id:'run2', name:'run_tools_code', status:'running'}, send);
  assert.equal(sent, 1);
  assert.match(messages[1]!, /┌ ◌ web_search · running\n└ 1 running/);
  assert.match(messages[2]!, /┌ ✓ web_search · 1.2s\n└ 1 completed/);
  assert.match(messages[4]!, /Run 1 · completed/);
  assert.match(messages[4]!, /Run 2 · running\n```\n┌ ◌ running/);
  assert.equal((messages[4]!.match(/web_search/g) ?? []).length, 1);
});

test('progress_failure_line_has_no_code_tag', () => {
  const calls: ToolActivity[] = [
    {id:'1',name:'shell',status:'rejected',reason:'[TOOL_BLOCKED] Sandbox template "slopbot" does not exist. Use action sandbox_manage to create it, then retry the command with the template name.'},
  ];
  const progress = toolProgress(calls, 'Blooming…');
  assert.match(progress, /-# ❌ shell blocked: Sandbox template "slopbot" does not exist\.$/m);
  assert.ok(!progress.includes('TOOL_BLOCKED'));
  assert.ok(!progress.includes('\\['));
  assert.ok(!progress.includes('Use action'));
  const long: ToolActivity[] = [{id:'2',name:'read',status:'failed',reason:'[IO_ERROR] ' + 'word '.repeat(60)}];
  const line = toolProgress(long, 'Blooming…').split('\n').find(text => text.startsWith('-# ❌')) ?? '';
  assert.ok(!line.includes('IO_ERROR'));
  assert.ok(line.length <= 'as -# ❌ read failed: '.length + 101);
});

test('footer_attach_file_plain_words', () => {
  const one: ToolActivity[] = [{id:'1',name:'attach_file',status:'completed'}];
  assert.equal(toolFooter(one, 'summary'), '\n\n-# attached 1 file');
  const two: ToolActivity[] = [{id:'1',name:'attach_file',status:'completed'},{id:'2',name:'attach_file',status:'completed'}];
  assert.equal(toolFooter(two, 'summary'), '\n\n-# attached 2 files');
  const others: ToolActivity[] = [
    {id:'3',name:'view_image',status:'completed'},
    {id:'4',name:'issue_draft',status:'completed'},
    {id:'5',name:'bot_info',status:'completed'},{id:'6',name:'bot_info',status:'completed'},{id:'7',name:'bot_info',status:'completed'},{id:'8',name:'bot_info',status:'completed'},{id:'9',name:'bot_info',status:'completed'},
  ];
  const footer = toolFooter(others, 'summary');
  assert.match(footer, /viewed 1 image/);
  assert.match(footer, /drafted an issue/);
  assert.match(footer, /read bot info 5×/);
  assert.ok(!footer.includes('attach file'));
});

test('footer_unknown_tool_fallback_plain', () => {
  const calls: ToolActivity[] = [
    {id:'1',name:'mystery_tool',status:'completed'},
    {id:'2',name:'mystery_tool',status:'completed'},
    {id:'3',name:'other_tool',status:'completed'},
  ];
  const footer = toolFooter(calls, 'summary');
  assert.equal(footer, '\n\n-# used mystery tool 2 times · used other tool');
  assert.ok(!footer.includes('×'));
});
