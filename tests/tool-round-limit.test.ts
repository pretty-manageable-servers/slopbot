import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { Application } from '../src/application.js';
import { describeError, RequestError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';

const message = {server:'s',channel:'c',author:'alice',id:'request',text:'Do the task',addressed:true};
const call = [{ name: "read", arguments: {} }];

test('default allows a task requiring more than eight rounds to finish', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); let rounds = 0, calls = 0;
  const app = new Application(store, {async *stream(){yield ++rounds <= 10 ? { kind: 'tool_call', payload: call } : { kind: 'text', payload: { text: 'Done' } };}},
    {allowedChannels:[{server:'s',channel:'c'}]}, undefined, {tools:{schemas: () => [], catalog:()=>'',execute:async()=>{calls++;return 'Result';}}});
  assert.equal((await app.handle(message))?.text, 'Done');
  assert.equal(calls, 10);
});

test('a limit failure retains its reason and retry gets new rounds without replaying tools', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); let rounds = 0, calls = 0;
  const app = new Application(store, {async *stream(){yield ++rounds < 6 ? { kind: 'tool_call', payload: call } : { kind: 'text', payload: { text: 'Done' } };}},
    {allowedChannels:[{server:'s',channel:'c'}],maxToolRounds:2}, undefined, {harness:store,tools:{schemas: () => [], catalog:()=>'',execute:async()=>{calls++;return 'Result';}}});
  await assert.rejects(app.handle(message), error => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, 'TOOL_ROUND_LIMIT');
    assert.equal(describeError(error).details?.limit, 2);
    assert.equal(describeError(error).details?.nextTools, 'read');
    return true;
  });
  assert.equal(calls, 2);
  const resumed = await app.handle(message, true);
  assert.equal(resumed?.text, 'Done');
  assert.equal(calls, 4);
  assert.equal(store.agentTurns(message).length, 4);
  assert.equal(resumed?.toolActivity?.filter(item => item.reused).length, 2);
});

test('MAX_TOOL_ROUNDS is configurable and rejects invalid budgets', () => {
  const env = {DISCORD_BOT_TOKEN:'test',DISCORD_GUILD_ID:'12345678901234567',LLM_MODE:'mock'};
  assert.equal(loadConfig(env).maxToolRounds, 64);
  assert.equal(loadConfig({...env,MAX_TOOL_ROUNDS:'256'}).maxToolRounds, 256);
  for (const value of ['0','1001','1.5','invalid']) assert.throws(() => loadConfig({...env,MAX_TOOL_ROUNDS:value}), /MAX_TOOL_ROUNDS/);
});
