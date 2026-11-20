import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { AgentRunner } from "../src/agent-runner.js";
import type { Message, ModelEvent, Prompt } from "../src/domain.js";
import type { LLM } from "../src/ports.js";

const CHAT = "a".repeat(32);
const CHANNEL = `web:${CHAT}`;
/** About 1000 tokens each at the default 3 bytes per token, so 40 of them overflow the budget. */
const BIG = "x".repeat(3000);

/** Answers summaries with summary-1, summary-2 and so on. Other prompts get a plain reply. Fails summaries when asked. */
class SummaryLLM implements LLM {
  readonly prompts: Prompt[] = [];
  private summaries = 0;
  constructor(private readonly failSummaries = false) {}
  async *stream(prompt: Prompt): AsyncIterable<ModelEvent> {
    this.prompts.push(prompt);
    if (prompt.prefixVersion === "web-summary-v1") {
      if (this.failSummaries) throw new Error("summary model down");
      yield { kind: "text", payload: { text: `summary-${++this.summaries}` } };
      return;
    }
    yield { kind: "text", payload: { text: "ok" } };
  }
  summaryPrompts(): Prompt[] { return this.prompts.filter(prompt => prompt.prefixVersion === "web-summary-v1"); }
  mainPrompt(): Prompt { return this.prompts.filter(prompt => prompt.prefixVersion !== "web-summary-v1").at(-1)!; }
}

const note = (index: number): Message => ({ id: `m${index}`, server: "s", channel: CHANNEL, author: "alice", text: `note-${index} ${BIG}`, timestamp: index + 1 });
/** The note numbers that appear in a prompt's items. */
const notesIn = (prompt: Prompt | undefined) => new Set([...JSON.stringify(prompt?.inputs ?? []).matchAll(/note-(\d+)/g)].map(match => Number(match[1])));

function setup(t: { after(fn: () => void): void }, llm: LLM) {
  const store = new SQLiteStore(); t.after(() => store.close());
  // A small window: 19000 tokens of history after 1000 for the reply.
  const runner = new AgentRunner(store, llm, { allowedChannels: [{ server: "s", channel: CHANNEL }], maxContextTokens: 20000, maxOutputTokens: 1000, maxInputChars: 150000 });
  const send = async (messages: Message[]) => {
    for (const message of messages) await store.ingest(message);
    return runner.run(messages.at(-1)!);
  };
  return { store, send };
}

test("compacts when over budget", async t => {
  const llm = new SummaryLLM();
  const { store, send } = setup(t, llm);
  await send(Array.from({ length: 40 }, (_, index) => note(index)));
  assert.equal(llm.summaryPrompts().length, 1);
  assert.equal((await store.webChatSummary(CHAT))?.summary, "summary-1");
  const seen = notesIn(llm.mainPrompt());
  assert.equal(seen.has(0), false);
  assert.equal(seen.has(39), true);
  assert.ok(JSON.stringify(llm.mainPrompt().inputs).includes("summary-1"));
});

test("keeps the newest 30% of the budget out of the summary", async t => {
  const llm = new SummaryLLM();
  const { send } = setup(t, llm);
  await send(Array.from({ length: 40 }, (_, index) => note(index)));
  const summarized = notesIn(llm.summaryPrompts()[0]);
  assert.equal(summarized.has(0), true);
  for (const index of [36, 37, 38, 39]) assert.equal(summarized.has(index), false, `note-${index} was summarized`);
  const kept = notesIn(llm.mainPrompt());
  for (const index of [36, 37, 38, 39]) assert.equal(kept.has(index), true, `note-${index} was dropped`);
});

test("nested summary includes the previous one", async t => {
  const llm = new SummaryLLM();
  const { store, send } = setup(t, llm);
  await send(Array.from({ length: 40 }, (_, index) => note(index)));
  await send(Array.from({ length: 40 }, (_, index) => note(index + 40)));
  assert.equal(llm.summaryPrompts().length, 2);
  assert.ok(JSON.stringify(llm.summaryPrompts()[1]!.inputs).includes("summary-1"));
  assert.equal((await store.webChatSummary(CHAT))?.summary, "summary-2");
});

test("failed summary keeps history", async t => {
  const llm = new SummaryLLM(true);
  const { store, send } = setup(t, llm);
  const reply = await send(Array.from({ length: 40 }, (_, index) => note(index)));
  assert.equal(reply?.text, "ok");
  assert.equal(await store.webChatSummary(CHAT), undefined);
  assert.equal(notesIn(llm.mainPrompt()).has(39), true);
});
