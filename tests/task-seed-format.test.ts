import assert from "node:assert/strict";
import { test } from "node:test";
import { Application } from "../src/application.js";
import { Bot, type ChatGateway, type Incoming } from "../src/bot.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import type { Prompt, ModelEvent } from "../src/domain.js";
import type { LLM } from "../src/ports.js";
import type { ToolExecutor } from "../src/tools.js";

const incoming = (id: string, text: string, extra: Partial<Incoming> = {}): Incoming => ({
  id, server: "s", channel: "c", author: "alice", text,
  botAuthor: false, mentionsBot: false, repliesToBot: false, ...extra,
});

function setup(options: { llm?: LLM; tools?: ToolExecutor } = {}) {
  const store = new SQLiteStore(":memory:");
  const llm = options.llm ?? new FakeLLM();
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, undefined, options.tools ? { tools: options.tools } : {});
  const gateway: ChatGateway = {
    async reply(message, text) {
      return [{ id: `out:${text.length}`, server: "s", channel: message.channel, author: "bot", text }];
    },
    async createTaskThread() { return "thread"; },
    typing() { return () => undefined; },
  };
  const bot = new Bot(app, store, store, gateway, "s", ["c"]);
  return { store, bot };
}

test("seed keeps reply target", async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.store.ingest(incoming("a1", "Plan the dinner for Friday"));
  await f.store.ingest(incoming("b2", "Unrelated chat", { author: "bob" }));
  const request = incoming("q3", "book the table", { replyTo: "a1", mentionsBot: true });
  await f.store.ingest(request);
  await f.bot.startTask(request, request.text);
  const seed = f.store.canonicalMessage("s", "task-seed:q3")!;
  const targetLines = seed.text.split("\n").filter(line => line.includes("[reply target]"));
  assert.equal(targetLines.length, 1, seed.text);
  assert.ok(targetLines[0]!.includes("Plan the dinner for Friday"), seed.text);
  assert.ok(!seed.text.includes("Unrelated chat"), seed.text);
});

/** An LLM that answers with one tool call, then "Done". Records every prompt. */
function scriptedLLM(call: string): { llm: LLM; prompts: Prompt[] } {
  const prompts: Prompt[] = [];
  let rounds = 0;
  const llm: LLM = {
    async *stream(prompt: Prompt): AsyncIterable<ModelEvent> {
      prompts.push(prompt);
      yield rounds++ === 0 ? { kind: "tool_call", payload: JSON.parse(call).tool_calls } : { kind: "text", payload: { text: "Done" } };
    },
  };
  return { llm, prompts };
}

/** A tool executor that records the arguments it runs with. */
function recordingTools(): { tools: ToolExecutor; executed: Record<string, unknown>[] } {
  const executed: Record<string, unknown>[] = [];
  const tools = {
    catalog: () => "",
    schemas: () => [],
    execute: async (_message: unknown, call: { arguments: Record<string, unknown> }) => { executed.push(call.arguments); return { text: "Result" }; },
  } as unknown as ToolExecutor;
  return { tools, executed };
}

test("task run resolves seed ref", async t => {
  const { tools, executed } = recordingTools();
  const { llm, prompts } = scriptedLLM('{"tool_calls":[{"name":"read","arguments":{"messageId":"s1"}}]}');
  const f = setup({ llm, tools }); t.after(() => f.store.close());
  await f.store.ingest(incoming("a1", "Plan the dinner for Friday"));
  const request = incoming("q3", "book the table", { replyTo: "a1", mentionsBot: true });
  await f.store.ingest(request);
  await f.bot.startTask(request, request.text);
  assert.deepEqual(executed, [{ messageId: "a1" }]);
  assert.ok(prompts.length >= 1);
});

test("s ref unknown errors", async t => {
  const { tools, executed } = recordingTools();
  const { llm, prompts } = scriptedLLM('{"tool_calls":[{"name":"read","arguments":{"messageId":"s9"}}]}');
  const f = setup({ llm, tools }); t.after(() => f.store.close());
  await f.store.ingest(incoming("a1", "Plan the dinner for Friday"));
  const request = incoming("q3", "book the table", { replyTo: "a1", mentionsBot: true });
  await f.store.ingest(request);
  await f.bot.startTask(request, request.text);
  assert.deepEqual(executed, []);
  assert.ok(JSON.stringify(prompts.at(-1)).includes("UNKNOWN_MESSAGE_REF"), JSON.stringify(prompts.at(-1)));
});
