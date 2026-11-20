import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { AgentRunner } from "../src/agent-runner.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import type { Message, ModelEvent, Prompt } from "../src/domain.js";
import type { LLM } from "../src/ports.js";
import { directMessageChannel } from "../src/private-chat.js";
import { incognitoChannel } from "../src/personal.js";

const CHAT = "a".repeat(32);
const OTHER = "b".repeat(32);

/** Answers with a usage event that reports the given prompt tokens. */
class UsageLLM implements LLM {
  readonly prompts: Prompt[] = [];
  constructor(private readonly promptTokens: number) {}
  async *stream(prompt: Prompt): AsyncIterable<ModelEvent> {
    this.prompts.push(prompt);
    yield { kind: "text", payload: { text: "ok" } };
    yield { kind: "usage", payload: { prompt_tokens: this.promptTokens, completion_tokens: 1 } };
  }
}

const chatRow = (id: string) => ({ id, server: "s", owner: "alice", title: "", created: 1, updated: 1, deleted: false, storageServer: null, titleSource: "auto" as const });
const note = (channel: string, index: number): Message => ({ id: `m${index}`, server: "s", channel, author: "alice", text: `note-${index}`, timestamp: index + 1 });
/** The note numbers that appear in a prompt's inputs. */
const notesIn = (prompt: Prompt) => new Set([...JSON.stringify(prompt.inputs).matchAll(/note-(\d+)/g)].map(match => Number(match[1])));

function setup(t: { after(fn: () => void): void }, llm: LLM, channels: string[]) {
  const store = new SQLiteStore(); t.after(() => store.close());
  const runner = new AgentRunner(store, llm, { allowedChannels: channels.map(channel => ({ server: "s", channel })) });
  const send = async (messages: Message[]) => {
    for (const message of messages) await store.ingest(message);
    return runner.run(messages.at(-1)!);
  };
  return { store, send };
}

test("web chat keeps 40 messages when they fit", async t => {
  const llm = new FakeLLM();
  const channel = `web:${CHAT}`;
  const { send } = setup(t, llm, [channel]);
  const messages = Array.from({ length: 40 }, (_, index) => note(channel, index));
  await send(messages);
  assert.equal(notesIn(llm.prompts.at(-1)!).size, 40);
});

test("discord channel still caps at reply_context", async t => {
  const llm = new FakeLLM();
  const { send } = setup(t, llm, ["c"]);
  await send(Array.from({ length: 40 }, (_, index) => note("c", index)));
  const seen = notesIn(llm.prompts.at(-1)!);
  // reply_context is 12 history messages; the request is the thirteenth.
  assert.ok(seen.size <= 13, `kept ${seen.size} messages`);
  assert.equal(seen.has(0), false);
  assert.equal(seen.has(39), true);
});

test("dm still caps at reply_context", async t => {
  const llm = new FakeLLM();
  const channel = directMessageChannel("123");
  const { send } = setup(t, llm, [channel]);
  await send(Array.from({ length: 40 }, (_, index) => note(channel, index)));
  const seen = notesIn(llm.prompts.at(-1)!);
  // reply_context is 12 history messages; the request is the thirteenth.
  assert.ok(seen.size <= 13, `kept ${seen.size} messages`);
  assert.equal(seen.has(0), false);
  assert.equal(seen.has(39), true);
});

test("ratio is saved and clamped to 1.5..6", async t => {
  const low = new UsageLLM(1);
  const high = new UsageLLM(1_000_000_000);
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.insertWebChat(chatRow(CHAT));
  await store.insertWebChat(chatRow(OTHER));
  const first = new AgentRunner(store, low, { allowedChannels: [{ server: "s", channel: `web:${CHAT}` }] });
  const second = new AgentRunner(store, high, { allowedChannels: [{ server: "s", channel: `web:${OTHER}` }] });
  await store.ingest(note(`web:${CHAT}`, 0));
  await first.run(note(`web:${CHAT}`, 0));
  await store.ingest(note(`web:${OTHER}`, 1));
  await second.run(note(`web:${OTHER}`, 1));
  assert.equal((await store.webChat(CHAT))?.bytesPerToken, 6);
  assert.equal((await store.webChat(OTHER))?.bytesPerToken, 1.5);
});

test("a private chat without a web_chats row still runs", async t => {
  const llm = new UsageLLM(100);
  const channel = incognitoChannel("c".repeat(32));
  const store = new SQLiteStore(); t.after(() => store.close());
  const runner = new AgentRunner(store, llm, { allowedChannels: [{ server: "s", channel }] });
  await store.ingest(note(channel, 0));
  const reply = await runner.run(note(channel, 0));
  assert.equal(reply?.text, "ok");
});
