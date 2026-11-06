import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolFooter, toolProgress } from '../src/presentation/tool-activity.js';
import { DiscordToolProgress } from '../src/clients/discord/discord-tool-progress.js';
import { Application } from '../src/application.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolError } from '../src/tools.js';
import { RequestError } from '../src/errors.js';
import type { ToolActivity } from '../src/tool-activity.js';

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
