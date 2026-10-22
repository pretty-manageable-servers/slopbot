import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolRegistry } from '../src/tools.js';
import { Application } from '../src/application.js';
import { ChatCompletionsLLM } from '../src/adapters/chat-completions.js';
import { sourceFingerprint } from '../src/source-context.js';
import type { Json, Message } from '../src/domain.js';

const options = {baseUrl:'https://example.com/v1',apiKey:'test',model:'test'};
const response = (choices: unknown[]) => new Response(choices.map(choice => `data: ${JSON.stringify({choices:[choice]})}\n\n`).join('') + 'data: [DONE]\n\n');
const oneLookup = () => response([{index:0,delta:{tool_calls:[{index:0,id:'call_one',type:'function',function:{name:'lookup',arguments:'{"query":"one"}'}}]},finish_reason:'tool_calls'}]);
const chatRequest = {server:'s',channel:'c',id:'request',author:'alice',text:'Look up the weather',addressed:true};
const done = () => response([{index:0,delta:{content:'Done.'},finish_reason:'stop'}]);

// One read tool. The callback runs during the call, as a user or channel change would.
const lookupExecutor = (store: SQLiteStore, duringCall: () => Promise<void>, ran: string[]) => {
  const registry = new ToolRegistry(store, async () => true);
  registry.register({name:'lookup',surface:'top',description:'Look up weather',fields:{query:{type:'string',description:'Search query',required:true}},access:'member',effect:'read',retrySafe:true,
    async execute(_context, args){ ran.push(String(args.query)); await duringCall(); return {text:'Sunny '+String(args.query)}; }});
  return {
    catalog: () => registry.catalog(),
    schemas: () => registry.schemas(),
    execute: (m: typeof chatRequest, call: {name:string;arguments:Record<string,Json>}, id: string) => registry.invokeResult(m, call.name, call.arguments, id, 'agent'),
  };
};

// Runs one request with one lookup call. Returns the bodies of the model requests and the reply text.
const runWithLookup = async (store: SQLiteStore, duringCall: () => Promise<void>, second: (body: string) => Response) => {
  const ran: string[] = [];
  const bodies: string[] = [];
  const llm = new ChatCompletionsLLM(options, async (_url, init) => {
    const raw = String(init?.body);
    bodies.push(raw);
    return bodies.length === 1 ? oneLookup() : second(raw);
  });
  const reply = await new Application(store, llm, {allowedChannels:[{server:'s',channel:'c'}]}, undefined, {tools: lookupExecutor(store, duringCall, ran), harness: store}).handle(chatRequest);
  return { ran, bodies, text: reply?.text };
};

const base: Message = {server:'s', channel:'c', id:'m1', author:'bob', text:'Look at this'};
const withPreview = (url: string): Message => ({
  ...base,
  text: `Look at this\n[Attachment preview.png, type unknown: ${url}; content not inspected]`,
  attachments: [{name:'preview.png', url, size:0, preview:true}],
});

test('link_preview_is_not_an_edit', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const previewed = withPreview('https://cdn.example/preview.png');
  assert.equal(sourceFingerprint(previewed), sourceFingerprint(base));
  await store.ingest(base);
  const turn = await store.addAgentTurn(base, '', [{ name: 'lookup', arguments: {} }]);
  await store.revise(previewed);
  assert.deepEqual((await store.agentTurns(base)).map(item => item.id), [turn.id]);
});

test('embed_change_is_not_an_edit', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  // A preview image replaced by another image is still no authored change.
  const first = withPreview('https://cdn.example/one.png'), second = withPreview('https://cdn.example/two.png');
  assert.equal(sourceFingerprint(first), sourceFingerprint(second));
  await store.ingest(first);
  const turn = await store.addAgentTurn(first, '', [{ name: 'lookup', arguments: {} }]);
  await store.revise(second);
  assert.deepEqual((await store.agentTurns(first)).map(item => item.id), [turn.id]);
});

test('request_edit_becomes_note', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const run = await runWithLookup(store, async () => { await store.ingest({...chatRequest, text: 'Look up the forecast for Oslo', revisionTimestamp: 2}); }, () => done());
  assert.deepEqual(run.ran, ['one']);
  assert.equal(run.text, 'Done.');
  assert.equal(run.bodies.length, 2);
  assert.match(run.bodies[1]!, /The user edited their request to: Look up the forecast for Oslo/);
  assert.match(run.bodies[1]!, /Sunny one/);
  assert.ok(!/Source or channel changed/.test(run.bodies[1]!));
});

test('channel_message_during_run_becomes_note', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const run = await runWithLookup(store, async () => { await store.ingest({...base, id: 'm-new', author: 'carol', authorName: 'Carol', text: 'Is Oslo the capital?'}); }, () => done());
  assert.deepEqual(run.ran, ['one']);
  assert.equal(run.text, 'Done.');
  assert.match(run.bodies[1]!, /Since you started/);
  assert.ok(run.bodies[1]!.includes('new message from Carol'));
  assert.ok(run.bodies[1]!.includes('Is Oslo the capital?'));
});

test('no_regenerate_on_context_change', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.ingest({...base, id: 'earlier', author: 'bob', text: 'Earlier note'});
  // An edit to an earlier message changes the chat during the call. The model output is kept and no second answer is generated.
  const run = await runWithLookup(store, async () => { await store.ingest({...base, id: 'earlier', author: 'bob', text: 'Earlier note, now edited', revisionTimestamp: 2}); }, () => done());
  assert.equal(run.text, 'Done.');
  assert.equal(run.bodies.length, 2);
  assert.deepEqual(run.ran, ['one']);
  assert.ok(!/changed many times/.test(run.text ?? ''));
});

test('own_memory_write_is_not_a_change', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  // The bot's own reply and its own memory write are not channel changes, so no note is due.
  const run = await runWithLookup(store, async () => {
    await store.ingest({...base, id: 'bot-reply', author: 'slopbot', isBot: true, text: 'First draft'});
    await store.ingest({...base, id: 'bot-reply', author: 'slopbot', isBot: true, text: 'Second draft', revisionTimestamp: 2});
    await store.remember({...base, id: 'request', author: 'alice'}, 'Alice likes tea');
  }, () => done());
  assert.equal(run.text, 'Done.');
  assert.ok(!/Since you started/.test(run.bodies[1]!));
});
