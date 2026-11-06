import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TavilySearch} from '../src/adapters/tavily.js';
import {ProviderFailed, type ProviderKey} from '../src/web-providers.js';
import {ToolError} from '../src/tools.js';

const secret='tvly-test-secret-value';
const key:ProviderKey={id:'k1',provider:'tavily',secret};
async function failure(promise:Promise<unknown>):Promise<ProviderFailed>{
 try{await promise;}catch(error){assert.ok(error instanceof ProviderFailed,String(error));return error;}
 assert.fail('expected ProviderFailed');
}

test('Tavily maps results, caps fields and filters duplicate or unsafe links',async()=>{
 const results=[
  {title:'One',url:'https://one.example/',content:'snippet'},
  {title:'duplicate',url:'https://one.example/'},
  {title:'script',url:'javascript:alert(1)'},
  {title:'credentials',url:'https://user:pass@creds.example/'},
  {title:'t'.repeat(300),url:'https://two.example/',content:'x'.repeat(1000)},
  {title:'Three',url:'https://three.example/',content:'third'},
 ];
 const search=new TavilySearch(async()=>Response.json({results}));
 const two=await search.search(key,'q',2);
 assert.deepEqual(two.map(hit=>hit.url),['https://one.example/','https://two.example/']);
 assert.equal(two[0]?.snippet,'snippet');
 assert.equal(two[1]?.title.length,200);assert.equal(two[1]?.snippet.length,800);
 const all=await search.search(key,'q',10);
 assert.deepEqual(all.map(hit=>hit.title.slice(0,5)),['One','ttttt','Three']);
 const one=await search.search(key,'q',1);
 assert.equal(one.length,1);
});
test('Tavily rejects bad input before any request',async()=>{
 let calls=0;
 const search=new TavilySearch(async()=>{calls++;return Response.json({results:[]});});
 await assert.rejects(search.search(key,'   ',5),ToolError);
 await assert.rejects(search.search(key,'x'.repeat(1001),5),ToolError);
 for(const limit of [0,11,1.5]) await assert.rejects(search.search(key,'q',limit),ToolError);
 assert.equal(calls,0);
});
test('Tavily HTTP 432 and 433 mark the key as exhausted',async()=>{
 for(const status of [432,433]){
  const error=await failure(new TavilySearch(async()=>new Response('{}',{status})).search(key,'q',1));
  assert.equal(error.provider,'tavily');assert.equal(error.keyExhausted,true);
 }
});
test('Tavily HTTP 401 marks the key as exhausted and says the key is invalid',async()=>{
 const error=await failure(new TavilySearch(async()=>new Response('{}',{status:401})).search(key,'q',1));
 assert.equal(error.keyExhausted,true);assert.match(error.message,/invalid/);
});
test('Tavily other HTTP errors are failures that do not exhaust the key',async()=>{
 const error=await failure(new TavilySearch(async()=>new Response('boom',{status:500})).search(key,'q',1));
 assert.equal(error.provider,'tavily');assert.equal(error.keyExhausted,false);assert.match(error.message,/500/);
});
test('Tavily network errors and timeouts are provider failures',async()=>{
 const error=await failure(new TavilySearch(async()=>{throw new TypeError('fetch failed');}).search(key,'q',1));
 assert.equal(error.provider,'tavily');assert.equal(error.keyExhausted,false);assert.match(error.message,/unavailable|timed out/);
});
test('Tavily rejects oversized, non-JSON and malformed replies',async()=>{
 const big=await failure(new TavilySearch(async()=>new Response('x'.repeat(1024*1024+1))).search(key,'q',1));
 assert.match(big.message,/1 MiB/);
 const text=await failure(new TavilySearch(async()=>new Response('<html>')).search(key,'q',1));
 assert.match(text.message,/JSON/);
 const shape=await failure(new TavilySearch(async()=>Response.json({error:'bad'})).search(key,'q',1));
 assert.match(shape.message,/Invalid/);
});
test('Tavily never puts the key secret in error messages',async()=>{
 const cases:Array<()=>Promise<unknown>>=[
  ()=>new TavilySearch(async()=>new Response('{}',{status:401})).search(key,'q',1),
  ()=>new TavilySearch(async()=>new Response('{}',{status:432})).search(key,'q',1),
  ()=>new TavilySearch(async()=>new Response('{}',{status:500})).search(key,'q',1),
  ()=>new TavilySearch(async()=>{throw new Error(`leaked ${secret}`);}).search(key,'q',1),
  ()=>new TavilySearch(async()=>new Response(`not json ${secret}`)).search(key,'q',1),
  ()=>new TavilySearch(async()=>new Response('x'.repeat(1024*1024+1))).search(key,'q',1),
 ];
 for(const run of cases){
  const error=await failure(run());
  assert.equal(error.message.includes(secret),false,error.message);
 }
});
