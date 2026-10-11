import { test } from "node:test";
import assert from "node:assert/strict";
import { EventJournal } from "../src/event-journal.js";
import { requestTimings } from "../src/request-timing.js";
import { PostgresStore } from "../src/adapters/postgres.js";
import type { Message } from "../src/domain.js";
import { Client } from "pg";

test("Postgres preserves identity, context, journals, queue ordering, vectors and source invalidation", {skip: !process.env.TEST_DATABASE_URL}, async () => {
  const url=process.env.TEST_DATABASE_URL!;
  const store=await PostgresStore.connect(url,{model:"test-3d", async embed(){return [1,0,0];}});
  const cleanup=new Client({connectionString:url});await cleanup.connect();
  const tables=(await cleanup.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows;
  await cleanup.query(`TRUNCATE ${tables.map(row=>`"${row.tablename}"`).join(',')} RESTART IDENTITY CASCADE`);await cleanup.end();
  const m:Message={server:"server",channel:"channel",id:"one",author:"person",authorName:"Oscar",text:"Hello testing memory",addressed:true,timestamp:1};
  try {
    assert.equal(await store.ingest(m),true);assert.equal(await store.ingest(m),false);await store.finishIndexing();
    assert.equal((await store.profile(m.server,m.author)).name,"Oscar");assert.equal((await store.findPeople(m.server,"Oscar"))[0]?.id,"person");
    await store.editProfile(m,m.author,"real_name","Oscar","profile-one");assert.equal((await store.profile(m.server,m.author)).fields[0]?.value,"Oscar");
    await store.setSetting(m.server,"test",123);assert.equal(store.setting(m.server,"test"),123);
    await store.registerTask(m.server,"thread",m.channel,m.id);assert.equal(store.taskThreads(m.server)[0]?.thread,"thread");assert.equal(await store.taskForSource(m.server,m.id),"thread");
    const newer={...m,id:"two",text:"Tell me about memory",timestamp:2,replyTo:m.id};await store.ingest(newer);await store.finishIndexing();
    assert.equal((await store.context(newer,5))[0]?.id,m.id);
    const keywordOnly=await PostgresStore.connect(url);try { assert.ok((await keywordOnly.retrieve({...newer,text:"hello"},10)).some(row=>row.sourceIds.includes(m.id))); } finally { await keywordOnly.close(); }
    assert.equal((await store.indexStats(m.server,m.channel)).vectors,2);
    assert.ok((await store.retrieve(newer,10)).some(row=>row.sourceIds.includes(m.id)));
    const memory=await store.remember(m,"A source linked memory");assert.equal((await store.memories(m.server,m.channel))[0]?.id,memory.id);
    await store.startRun("run",newer,{prefixVersion:"v1",prefix:[],history:[],inputs:[]});await store.recordSources("run",m.server,[m.id]);
    await store.appendEvent("run",0,{kind:"reasoning",payload:{text:"Preserve me"}});await store.appendEvent("run",1,{kind:"usage",payload:{prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cached_tokens:5}}});
    await store.complete("run",JSON.stringify([m.server,m.channel,"task"]),[],"Reply");assert.equal((await store.llmUsage(m.server)).cached,5);assert.equal((await store.historyArchive(JSON.stringify([m.server,m.channel,"task"]))).length,1);
    const turn=await store.addAgentTurn(newer,"",[{name:"status",arguments:{}}]);await store.agentResult(turn.id,0,{text:"ok"});assert.equal((await store.agentTurns(newer))[0]?.results["0"] && true,true);
    const a=await store.enqueueJob(m),b=await store.enqueueJob(newer);assert.equal(await store.acquireWorker(m.server,"owner",Date.now()+60000),true);assert.equal(await store.acquireWorker(m.server,"other",Date.now()+60000),false);
    assert.equal((await store.claimJob(m.server))?.id,a.id);assert.equal(await store.claimJob(m.server),undefined);await store.finishJob(a.id);assert.equal((await store.claimJob(m.server))?.id,b.id);
    await store.prepareDelivery("delivery",m,"reply");await store.finishDelivery("delivery",newer);assert.equal((await store.delivery("delivery"))?.result?.id,newer.id);
    await store.revise({...m,text:"Changed"});assert.equal((await store.memories(m.server,m.channel)).length,0);assert.equal((await store.profile(m.server,m.author)).fields.length,0);assert.equal((await store.events("run"))[0]?.kind,"reasoning");
    await store.remove(m.server,m.channel,newer.id);assert.equal(await store.ingest(newer),false);
    await store.setSetting(m.server,`history:${m.channel}`,{days:150});await store.purgeUnconfigured(m.server,[]);assert.equal(store.setting(m.server,`history:${m.channel}`),undefined);
  } finally { await store.finishIndexing();await store.close(); }
});

test("development schemas isolate settings and messages on the same database", {skip: !process.env.TEST_DATABASE_URL}, async () => {
  const url=process.env.TEST_DATABASE_URL!;
  const a=await PostgresStore.connect(url,undefined,"slopbot_test_a");
  const b=await PostgresStore.connect(url,undefined,"slopbot_test_b");
  try {
    await a.setSetting("schema-test","isolated",42);
    assert.equal(b.setting("schema-test","isolated"),undefined);
    const message:Message={server:"schema-test",channel:"test",id:"one",author:"test",text:"isolated",timestamp:1,addressed:false};
    await a.ingest(message);
    assert.equal((await b.indexStats("schema-test","test")).messages,0);
  } finally {
    await a.close();await b.close();
    const cleanup=new Client({connectionString:url});await cleanup.connect();
    await cleanup.query('DROP SCHEMA slopbot_test_a CASCADE; DROP SCHEMA slopbot_test_b CASCADE');await cleanup.end();
  }
});

test("stopping background indexing retains messages for a later restart", {skip: !process.env.TEST_DATABASE_URL}, async () => {
  const url=process.env.TEST_DATABASE_URL!;
  const embeddings={model:"test-stop",async embed(){return [1,0,0];}};
  const message:Message={server:"stop-test",channel:"test",id:"one",author:"test",text:"Keep this message",timestamp:1,addressed:false};
  let store=await PostgresStore.connect(url,embeddings,"slopbot_test_stop");
  try {
    store.stopIndexing();await store.ingest(message);await store.finishIndexing();
    assert.equal((await store.indexStats(message.server,message.channel)).messages,1);
    assert.equal((await store.indexStats(message.server,message.channel)).vectors,0);
    await store.close();store=await PostgresStore.connect(url,embeddings,"slopbot_test_stop");
    assert.equal(await store.reindex(message.server,[message.channel]),1);
    await store.finishIndexing();assert.equal((await store.indexStats(message.server,message.channel)).vectors,1);
  } finally {
    await store.close();const cleanup=new Client({connectionString:url});await cleanup.connect();
    await cleanup.query('DROP SCHEMA slopbot_test_stop CASCADE');await cleanup.end();
  }
});

test('new search and feature records use an isolated Postgres schema', {skip: !process.env.TEST_DATABASE_URL}, async () => {
  const url=process.env.TEST_DATABASE_URL!;
  const schema='slopbot_test_features_'+Date.now().toString(36);
  const embeddings={model:'test-features',async embed(text:string){return text.includes('cat')?[0,1,0]:[1,0,0];}};
  const store=await PostgresStore.connect(url,embeddings,schema);
  try {
    const base={server:'feature-test',channel:'test',author:'person'};
    await store.ingest({...base,id:'3',text:'deploy is done',timestamp:300});
    await store.ingest({...base,id:'1',text:'deploy starts',timestamp:100});
    await store.ingest({...base,id:'2',text:'deploy running',timestamp:200});
    await store.ingest({...base,id:'4',text:'cat',timestamp:400});
    await store.finishIndexing();
    assert.deepEqual((await store.readHistory(base.server,base.channel,'2',1)).map(message=>message.id),['1','2','3']);
    const search=await store.searchHistory({server:base.server,channel:base.channel,query:'deploy',mode:'hybrid',limit:10});
    assert.equal(search.degraded,false);assert.ok(search.messages.some(message=>message.id==='3'));
    assert.equal((await store.searchHistory({server:base.server,channel:base.channel,query:'deploy starts',mode:'exact',limit:10})).messages.length,1);
    assert.equal(await store.putRecord(base.server,'ui','one',{text:'hello'},0),true);
    const claims=await Promise.all([store.putRecord(base.server,'ui','one',{text:'a'},1),store.putRecord(base.server,'ui','one',{text:'b'},1)]);
    assert.equal(claims.filter(Boolean).length,1);assert.equal((await store.record(base.server,'ui','one'))?.revision,2);
  } finally {
    await store.finishIndexing();await store.close();
    const cleanup=new Client({connectionString:url});await cleanup.connect();
    await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);await cleanup.end();
  }
});

test('stream event batches preserve all deltas in an isolated Postgres schema', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const url=process.env.TEST_DATABASE_URL!,schema='slopbot_test_event_batches_'+Date.now().toString(36);
  const store=await PostgresStore.connect(url,undefined,schema);
  try {
    const message={server:'event-test',channel:'test',author:'a',id:'m',text:'test'};
    await store.startRun('run',message,{prefixVersion:'v1',prefix:[],history:[],inputs:[]});
    const journal=new EventJournal(store,'run',message,'model');
    const batchStart=performance.now();
    for(let index=0;index<65;index++)await journal.append({kind:'reasoning',payload:{index,text:'raw delta'}});
    await journal.close();
    const batchMs=performance.now()-batchStart;
    const events=await store.events('run');assert.equal(events.length,65);
    assert.deepEqual(events.map(event=>(event.payload as any).index),Array.from({length:65},(_,index)=>index));
    await store.startRun('sequential',message,{prefixVersion:'v1',prefix:[],history:[],inputs:[]});
    const sequentialStart=performance.now();
    for(let index=0;index<65;index++)await store.appendEvent('sequential',index,{kind:'reasoning',payload:{index,text:'raw delta'}});
    t.diagnostic(`65 events: batched ${Math.round(batchMs)}ms; sequential ${Math.round(performance.now()-sequentialStart)}ms`);
    requestTimings.begin(message);
    await requestTimings.withScope(message,()=>store.appendEvents('measured',0,[{kind:'reasoning',payload:{text:'measured'}}]));
    const trace=requestTimings.finish(message)!;
    assert.ok('database connection queue' in trace.blockedMs!);
    assert.ok('database insert events' in trace.blockedMs!);
  } finally {
    await store.close();const cleanup=new Client({connectionString:url});await cleanup.connect();
    await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);await cleanup.end();
  }
});
