import { test } from "node:test";
import assert from "node:assert/strict";
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
