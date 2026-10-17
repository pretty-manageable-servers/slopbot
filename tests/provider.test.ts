import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatCompletionsLLM, ProviderError, sseData, wireMessages } from "../src/adapters/chat-completions.js";
import type { ModelEvent, Prompt } from "../src/domain.js";

const prompt: Prompt = {
  prefixVersion: "v1", prefix: [{ role: "system", content: "fixed" }], history: [],
  inputs: [{ role: "user", content: "hello", author: "alice" }],
};
const options = { baseUrl: "https://api.pmservers.org/ai/v1", apiKey: "test-only", model: "llama.cpp/gemma-4-e4b-qat" };

test("provider requests use configured endpoint/model and preserve prefix", async () => {
  let body: Record<string, unknown> = {};
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.pmservers.org/ai/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-only");
    body = JSON.parse(String(init?.body));
    return new Response(
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"reason"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens_details":{"cached_tokens":10}}}\n\n' +
      'data: [DONE]\n\n',
    );
  };
  const events: ModelEvent[] = [];
  for await (const event of new ChatCompletionsLLM(options, fetcher).stream(prompt)) events.push(event);
  assert.equal(body.model, "llama.cpp/gemma-4-e4b-qat");
  assert.deepEqual((body.messages as unknown[])[0], { role: "system", content: "fixed" });
  assert.equal(events.filter(event => event.kind === "opaque").length, 4);
  assert.ok(events.some(event => event.kind === "reasoning"));
  assert.ok(events.some(event => event.kind === "usage"));
  assert.deepEqual(events.find(event => event.kind === "text"), { kind: "text", payload: { text: "Hi" } });
  assert.equal(wireMessages(prompt)[1]?.content, "hello");
});

test("SSE handles split Unicode, CRLF, comments and multiple data lines", async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\ndata: {"text":\r\ndata: "🙂"}\r\n\r\n');
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(index, ++index));
    },
  });
  const values: string[] = [];
  for await (const data of sseData(body)) values.push(data);
  assert.deepEqual(values.map(value => JSON.parse(value)), [{ text: "🙂" }]);
});

test("HTTP errors do not expose response bodies or credentials", async () => {
  const llm = new ChatCompletionsLLM(options, async () => new Response("sensitive upstream body", { status: 401 }));
  await assert.rejects(async () => { for await (const event of llm.stream(prompt)) void event; }, error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes("sensitive"));
    return true;
  });
});

test("Gemma tool markers are normalized while original streamed text is retained", async () => {
  const raw = '<|tool_call>call:cooldown{"seconds":120,"per_hour":5}<tool_call|>';
  const llm = new ChatCompletionsLLM(options, async () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: raw }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
  const events: ModelEvent[] = [];
  for await (const event of llm.stream(prompt)) events.push(event);
  assert.deepEqual(events.find(event => event.kind === "text"), { kind: "text", payload: { text: raw } });
  assert.deepEqual(events.find(event => event.kind === "tool_call"), { kind: "tool_call", payload: [{ name: "cooldown", arguments: { seconds: 120, per_hour: 5 } }] });
  assert.ok(events.some(event => event.kind === "opaque"));
});

test("fragmented native tool calls assemble before execution", async () => {
  const chunks = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "cooldown", arguments: '{"seconds":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '120,"per_hour":5}' } }] }, finish_reason: "tool_calls" }] },
  ];
  const llm = new ChatCompletionsLLM(options, async () => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"));
  const events: ModelEvent[] = [];
  for await (const event of llm.stream(prompt)) events.push(event);
  assert.deepEqual(events.find(event => event.kind === "tool_call"), { kind: "tool_call", payload: [{ name: "cooldown", arguments: { seconds: 120, per_hour: 5 } }] });
});

test("malformed Gemma text is shown as text and never executed", async t => {
  const {Application}=await import('../src/application.js');
  const {SQLiteStore}=await import('../src/adapters/sqlite.js');
  const store=new SQLiteStore();t.after(()=>store.close());
  let requests=0,searches=0;
  const reply='<|tool_call>call:web_search{\\"query\\":\\"what is openclaw\\"}\n';
  const llm=new ChatCompletionsLLM(options,async()=>{requests++;return new Response(`data: ${JSON.stringify({choices:[{index:0,delta:{content:reply},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);});
  const app=new Application(store,llm,{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:{schemas: () => [], catalog:()=>'',execute:async()=>{searches++;return {text:'actual results',sources:[{kind:'web',url:'https://example.com/',title:'Result'}]};}}});
  assert.equal((await app.handle({id:'m',server:'s',channel:'c',author:'a',text:'search what is openclaw'}))?.text,reply);
  assert.equal(searches,0);assert.equal(requests,1);
});

test('tool rounds and subsequent task turns append identical wire prefixes',async t=>{
 const {Application}=await import('../src/application.js');
 const {SQLiteStore}=await import('../src/adapters/sqlite.js');
 const store=new SQLiteStore();t.after(()=>store.close());
 const requests:any[][]=[];
 const native=(id:string,query:string)=>({choices:[{index:0,delta:{tool_calls:[{index:0,id,type:'function',function:{name:'lookup',arguments:JSON.stringify({query})}}]},finish_reason:'tool_calls'}]});
 const replies=[native('call_one','one'),native('call_two','two'),{choices:[{index:0,delta:{content:'Done.'},finish_reason:'stop'}]},{choices:[{index:0,delta:{content:'Next answer.'},finish_reason:'stop'}]}];
 const llm=new ChatCompletionsLLM(options,async(_url,init)=>{
  requests.push(JSON.parse(String(init?.body)).messages);
  return new Response(`data: ${JSON.stringify(replies[requests.length-1])}\n\ndata: [DONE]\n\n`);
 });
 let calls=0;
 const app=new Application(store,llm,{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:{schemas: () => [], catalog:()=>'',execute:async()=>({text:`Result ${++calls}: `+'evidence '.repeat(10000)})}});
 await app.handle({id:'one',server:'s',channel:'c',author:'alice',text:'Investigate',taskId:'task'});
 await app.handle({id:'two',server:'s',channel:'c',author:'bob',text:'Continue',taskId:'task'});
 assert.equal(calls,2);assert.equal(requests.length,4);
 for(let index=1;index<requests.length;index++){
  assert.deepEqual(requests[index]!.slice(0,requests[index-1]!.length),requests[index-1]);
 }
});
