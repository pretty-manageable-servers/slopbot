import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestRequestTool, personResponses, shouldRecall } from '../src/request-routing.js';
import type { Message } from '../src/domain.js';
import type { ToolExecutor } from '../src/tools.js';
const request: Message = {id:'request',server:'s',channel:'c',author:'alice',text:'analyze this gif',replyTo:'file'};
test('reply file routing supplies attachments without replacing request identity', () => {
 const target = {...request,id:'file',author:'bob',text:'',attachments:[{name:'a.gif',url:'https://cdn.discordapp.com/a.gif'}]};
 let seen: Message | undefined;
 const tools: ToolExecutor = {catalog:()=>'',execute:async()=>'',suggest:message=>{seen=message;return {name:'read',arguments:{}};}};
 assert.equal(suggestRequestTool(tools,request,target)?.name,'read');
 assert.equal(seen?.id,request.id); assert.equal(seen?.author,request.author); assert.equal(seen?.attachments,target.attachments);
 assert.equal(request.attachments,undefined);
});
test('person responses quote only the resolved author and preserve original text', () => {
 const scope = {kind:'retrieval' as const,content:'resolved',author:'alice',targetAuthor:'bob',sourceIds:[]};
 const evidence = [{kind:'message' as const,content:'actual quote',author:'bob',authorName:'Bob',sourceIds:['one'],sourceUrl:'https://discord.com/channels/s/c/one'}, {kind:'message' as const,content:'other speaker',author:'alice',sourceIds:['two']}];
 const response=personResponses({...request,text:'list quotes'},evidence,scope);
 assert.equal(response.quotes.length,1); assert.match(response.quoteAnswer!,/actual quote/); assert.doesNotMatch(response.quoteAnswer!,/other speaker/);
 assert.equal(shouldRecall(request),false); assert.equal(shouldRecall({...request,text:'what did Bob say?'}),true);
});

test('application renders known IDs while task history retains the original model output', async t => {
 const { SQLiteStore } = await import('../src/adapters/sqlite.js');
 const { Application } = await import('../src/application.js');
 const store = new SQLiteStore(); t.after(()=>store.close());
 const id = '474858037970993152';
 await store.ingest({...request,id:'identity',author:id,authorName:'Teddio',text:'hello'});
 const app=new Application(store,{async *stream(){yield {kind:'reasoning',payload:{delta:'retained'}};yield {kind:'text',payload:{text:`The user ${id} asked.`}};}},{allowedChannels:[{server:'s',channel:'c'}]},undefined,{profiles:store});
 const reply=await app.handle({...request,id:'task-message',replyTo:undefined,taskId:'task',text:'hello'});
 assert.equal(reply?.text,'The user Teddio asked.');
 const history=await store.history(JSON.stringify(['s','c','task']));
 assert.equal(history.at(-1)?.content,`The user ${id} asked.`);
});
