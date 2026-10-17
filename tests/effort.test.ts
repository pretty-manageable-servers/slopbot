import test from "node:test";
import assert from "node:assert/strict";
import { ChatCompletionsLLM } from "../src/adapters/chat-completions.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import type { Prompt } from "../src/domain.js";

const prompt = (effort?: "low" | "medium" | "xhigh"): Prompt => ({ prefixVersion: "t", prefix: [], history: [], inputs: [{ role: "user", content: "hi" }], ...(effort ? { effort } : {}) });
const ok = () => new Response('data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
const drain = async (llm: ChatCompletionsLLM, p: Prompt) => { for await (const _ of llm.stream(p)) { /* read all */ } };

test("a model that rejects effort gets one retry without it and is remembered", async () => {
  const bodies: Record<string, unknown>[] = [];
  const llm = new ChatCompletionsLLM({ baseUrl: "https://llm.example/v1", model: "m", apiKey: "k" }, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return "reasoning_effort" in body ? Response.json({ error: { code: "invalid_request", message: "Unknown parameter: reasoning_effort" } }, { status: 400 }) : ok();
  });
  await drain(llm, prompt("low"));
  assert.equal(bodies.length, 2);
  assert.ok("reasoning_effort" in bodies[0]! && !("reasoning_effort" in bodies[1]!));
  await drain(llm, prompt("low"));
  assert.equal(bodies.length, 3, "the next request is sent once, without effort");
  assert.ok(!("reasoning_effort" in bodies[2]!));
});

test("the runner puts the message effort, else the server default, into the prompt", async t => {
  const llm = new FakeLLM(); const store = new SQLiteStore(); t.after(() => store.close());
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] });
  const message = (id: string, extra = {}) => ({ id, server: "s", channel: "c", author: "a", text: "hello", ...extra });
  await app.handle(message("1"));
  assert.equal(llm.prompts.at(-1)!.effort, undefined, "no setting: the provider decides");
  store.setSetting("s", "default_effort", "low");
  await app.handle(message("2"));
  assert.equal(llm.prompts.at(-1)!.effort, "low");
  await app.handle(message("3", { effort: "xhigh" }));
  assert.equal(llm.prompts.at(-1)!.effort, "xhigh");
});
