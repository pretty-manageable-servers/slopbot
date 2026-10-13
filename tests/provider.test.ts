import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatCompletionsLLM, ProviderError, sseData, wireMessages } from "../src/adapters/chat-completions.js";
import type { ModelEvent, Prompt } from "../src/domain.js";
import { requestTimings } from "../src/request-timing.js";

const prompt: Prompt = {
  prefixVersion: "v1", prefix: [{ role: "system", content: "fixed" }], history: [],
  inputs: [{ role: "user", content: "hello", author: "alice" }],
};
const options = { baseUrl: "https://api.pmservers.org/ai/v1", apiKey: "test-only", model: "llama.cpp/gemma-4-e4b-qat" };

test('provider boundaries record headers and stream reads separately without changing prompts',async()=>{
 const message={server:'s',channel:'c',id:'provider-boundaries'};
 const llm=new ChatCompletionsLLM(options,async()=>{
   await new Promise(resolve=>setTimeout(resolve,10));
   return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
 });
 requestTimings.begin(message);
 await requestTimings.withScope(message,async()=>{for await(const event of llm.stream(prompt))void event;});
 const timing=requestTimings.finish(message)!;
 assert.ok((timing.blockedMs!['reply model response headers']??0)>=1);
 assert.ok('reply model stream read' in timing.blockedMs!);
 assert.equal(Object.values(timing.blockedMs!).reduce((sum,ms)=>sum+ms,0),timing.totalMs);
});

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
  assert.equal(wireMessages(prompt)[1]?.content, '{"author_id":"alice","text":"hello"}');
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

test("provider receives the full reply budget without a Discord size cap", async () => {
  const text = "Long response 🙂\n".repeat(5000);
  const llm = new ChatCompletionsLLM(options, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 50000);
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  let result = "";
  for await (const event of llm.stream({ ...prompt, maxOutputTokens: 50000 })) {
    if (event.kind === "text") result += event.payload.text;
  }
  const { splitReply } = await import("../src/bot.js");
  const parts = splitReply(result);
  assert.ok(parts.length > 2);
  assert.ok(parts.every(part => part.length <= 1900));
  assert.equal(parts.join(""), text);
  assert.deepEqual(splitReply(result), parts);
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

test("truncated streams fail instead of reporting a successful answer", async () => {
  const llm = new ChatCompletionsLLM(options, async () => new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
  ));
  await assert.rejects(async () => { for await (const event of llm.stream(prompt)) void event; }, /before completion/);
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

test("malformed Gemma text reaches protocol repair with raw events intact", async t => {
  const {Application}=await import('../src/application.js');
  const {SQLiteStore}=await import('../src/adapters/sqlite.js');
  const store=new SQLiteStore();t.after(()=>store.close());
  let requests=0,searches=0;
  const replies=['<|tool_call>call:web_search{\\"query\\":\\"what is openclaw\\"}\n','{"tool_calls":[{"name":"web_search","arguments":{"query":"what is openclaw"}}]}','Here is the search result.'];
  const llm=new ChatCompletionsLLM(options,async()=>new Response(`data: ${JSON.stringify({choices:[{index:0,delta:{content:replies[requests++]},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`));
  const app=new Application(store,llm,{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:{catalog:()=>'',execute:async()=>{searches++;return {text:'actual results',sources:[{kind:'web',url:'https://example.com/',title:'Result'}]};}}});
  assert.equal((await app.handle({id:'m',server:'s',channel:'c',author:'a',text:'search what is openclaw'}))?.text,'Here is the search result.');
  assert.equal(searches,1);assert.equal(requests,3);
});

test('tool rounds and subsequent task turns append identical wire prefixes',async t=>{
 const {Application}=await import('../src/application.js');
 const {SQLiteStore}=await import('../src/adapters/sqlite.js');
 const store=new SQLiteStore();t.after(()=>store.close());
 const requests:any[][]=[];
 const replies=[JSON.stringify({tool_calls:[{name:'lookup',arguments:{query:'one'}}]}),JSON.stringify({tool_calls:[{name:'lookup',arguments:{query:'two'}}]}),'Done.','Next answer.'];
 const llm=new ChatCompletionsLLM(options,async(_url,init)=>{
  requests.push(JSON.parse(String(init?.body)).messages);
  return new Response(`data: ${JSON.stringify({choices:[{index:0,delta:{content:replies[requests.length-1]},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
 });
 let calls=0;
 const app=new Application(store,llm,{allowedChannels:[{server:'s',channel:'c'}]},undefined,{tools:{catalog:()=>'',execute:async()=>({text:`Result ${++calls}: `+'evidence '.repeat(10000)})}});
 await app.handle({id:'one',server:'s',channel:'c',author:'alice',text:'Investigate',taskId:'task'});
 await app.handle({id:'two',server:'s',channel:'c',author:'bob',text:'Continue',taskId:'task'});
 assert.equal(calls,2);assert.equal(requests.length,4);
 for(let index=1;index<requests.length;index++){
  assert.deepEqual(requests[index]!.slice(0,requests[index-1]!.length),requests[index-1]);
 }
 assert.ok(JSON.stringify(requests[1]).includes('truncated for context'));
 const {requestTimings}=await import('../src/request-timing.js');
 const timing=requestTimings.finish({server:'s',channel:'c',id:'one'})!;
 assert.ok(timing.steps.context!==undefined);
 assert.ok(timing.steps.model!==undefined);
 assert.ok(timing.steps['tool:lookup']!==undefined);
 assert.equal(timing.firstOutputMs.length,3);
 requestTimings.finish({server:'s',channel:'c',id:'two'});
});


test("provider output exhaustion reports the budget and checkpoint stage", async () => {
  const llm = new ChatCompletionsLLM(options, async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
  const partial: string[] = [];
  await assert.rejects(async () => {
    for await (const event of llm.stream({ ...prompt, purpose: "checkpoint", maxOutputTokens: 2048 })) {
      if (event.kind === "text") partial.push(event.payload.text);
    }
  }, (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "details" in error);
    assert.equal(error.code, "MODEL_OUTPUT_LIMIT");
    assert.deepEqual(error.details, { maxOutputTokens: 2048, purpose: "checkpoint", configuredOutputTokens: 50000, contextTokens: 200000 });
    return true;
  });
  assert.deepEqual(partial, ["partial"]);
});
