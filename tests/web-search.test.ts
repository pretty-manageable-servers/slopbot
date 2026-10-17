import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearxNGSearch } from '../src/adapters/searxng.js';
import { registerWebSearch } from '../src/web-search.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolRegistry } from '../src/tools.js';

test('SearXNG sends bounded search arguments and filters duplicate or unsafe links',async()=>{
 let requested: URL | undefined;
 const search=new SearxNGSearch('https://search.example/base',async input=>{requested=new URL(String(input));return Response.json({results:[{title:'One',url:'https://one.example/',content:'snippet'}, {title:'duplicate',url:'https://one.example/'},{url:'javascript:alert(1)'},{title:'Two',url:'https://two.example/',content:'x'.repeat(1000)}]});});
 const results=await search.search('current news',2);
 assert.equal(requested?.pathname,'/base/search');assert.equal(requested?.searchParams.get('q'),'current news');assert.equal(requested?.searchParams.get('format'),'json');
 assert.equal(results.length,2);assert.equal(results[1]?.snippet.length,800);
});

test('web search is shared, returns structured sources and replays without another request',async t=>{
 const store=new SQLiteStore();t.after(()=>store.close());const registry=new ToolRegistry(store,async()=>false);let calls=0;
 registerWebSearch(registry,{search:async()=>{calls++;return [{title:'One',url:'https://one.example/',snippet:'result'}];}});
 const message={id:'m',server:'s',channel:'c',author:'a',text:'search'};
 const first=await registry.invokeResult(message,'web_search',{query:'query'},'one','agent');
 assert.equal(first.sources?.[0]?.kind,'web');
 assert.deepEqual(await registry.invokeResult(message,'web_search',{query:'query'},'one','agent'),first);
 assert.equal(calls,1);assert.match(await registry.invoke(message,'web_search',{query:'query'},'one','command'),/result/);
});

test('protected search sends Access credentials only over HTTPS and refuses redirects',async()=>{
 const access={clientId:'test-id',clientSecret:'test-secret'};
 assert.throws(()=>new SearxNGSearch('http://search.example',fetch,Date.now,access),/HTTPS/);
 let calls=0;
 const search=new SearxNGSearch('https://search.example',async(_input,init)=>{
   calls++;
   const headers=new Headers(init?.headers);
   assert.equal(headers.get('CF-Access-Client-Id'),access.clientId);
   assert.equal(headers.get('CF-Access-Client-Secret'),access.clientSecret);
   assert.equal(init?.redirect,'error');
   return Response.json({results:[]});
 },Date.now,access);
 await search.search('hello',1);assert.equal(calls,1);
});
