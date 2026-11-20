import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ChatTitles } from "../src/chat-titles.js";
import { WebChatService, type ChatDeps } from "../src/clients/web/web-chats.js";
import type { Message, ModelEvent, Prompt } from "../src/domain.js";
import { incognitoChannel } from "../src/personal.js";
import { newPrivateChatId, privateChannel } from "../src/private-chat.js";
import type { LLM } from "../src/ports.js";

const server = "100000000000000001";
const owner = "alice";

/** A model that answers with one text. It can wait on a gate after it has started, so a test can act during the call. */
class TitleLlm implements LLM {
  readonly model = "title-model";
  readonly prompts: Prompt[] = [];
  readonly started: Promise<void>;
  private begin!: () => void;
  private release!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });

  constructor(private readonly answer: string, private readonly gated = false, public fail = false) {
    this.started = new Promise<void>(resolve => { this.begin = resolve; });
  }

  open(): void { this.release(); }

  async *stream(prompt: Prompt): AsyncIterable<ModelEvent> {
    this.prompts.push(prompt);
    this.begin();
    if (this.gated) await this.gate;
    if (this.fail) throw new Error("model is down");
    yield { kind: "text", payload: { text: this.answer } };
  }
}

/** A web chat with one exchange: the user asks, Slopbot replies. The chat keeps the given title source. */
async function seedChat(store: SQLiteStore, id: string, ask: string, updated = 1): Promise<Message> {
  const channel = privateChannel(id);
  await store.insertWebChat({ id, server, owner, title: ask, created: 1, updated, deleted: false, storageServer: null, titleSource: "auto" });
  await store.ingest({ id: `ask-${id}`, server, channel, author: owner, authorName: "Alice", isBot: false, text: ask, timestamp: 2, addressed: true });
  const reply: Message = { id: `reply-${id}`, server, channel, author: "slopbot", authorName: "Slopbot", isBot: true, text: `Answer about ${ask}`, timestamp: 3, addressed: false };
  await store.ingest(reply);
  return reply;
}

/** The chat service with only what rename needs: the user is a member of the server. */
function chatService(store: SQLiteStore): WebChatService {
  return new WebChatService(store, { directory: { isMember: async () => true } } as unknown as ChatDeps);
}

test("the first reply gives the chat a model title", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const id = newPrivateChatId();
  const reply = await seedChat(store, id, "plan a trip to Lisbon in May");
  const llm = new TitleLlm("Lisbon trip in May");
  await new ChatTitles(store, llm).replied(reply);
  const chat = await store.webChat(id);
  assert.equal(chat?.title, "Lisbon trip in May");
  assert.equal(chat?.titleSource, "model");
  assert.match(JSON.stringify(llm.prompts[0]?.inputs), /plan a trip to Lisbon in May/);
});

test("a user rename is kept when the reply comes later", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const id = newPrivateChatId();
  const reply = await seedChat(store, id, "plan a trip to Lisbon in May");
  await chatService(store).rename(owner, id, "My trip");
  await new ChatTitles(store, new TitleLlm("Lisbon trip in May")).replied(reply);
  const chat = await store.webChat(id);
  assert.equal(chat?.title, "My trip");
  assert.equal(chat?.titleSource, "user");
});

test("a rename during the model call wins", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const id = newPrivateChatId();
  const reply = await seedChat(store, id, "plan a trip to Lisbon in May");
  const llm = new TitleLlm("Lisbon trip in May", true);
  const titling = new ChatTitles(store, llm).replied(reply);
  await llm.started;
  await chatService(store).rename(owner, id, "My trip");
  llm.open();
  await titling;
  const chat = await store.webChat(id);
  assert.equal(chat?.title, "My trip");
  assert.equal(chat?.titleSource, "user");
});

test("a model title never replaces a user title in the store", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const id = newPrivateChatId();
  await seedChat(store, id, "plan a trip to Lisbon in May");
  await store.setWebChatTitle(id, "My trip", "user", 5);
  await store.setWebChatTitle(id, "Lisbon trip in May", "model", 6);
  assert.equal((await store.webChat(id))?.title, "My trip");
});

test("a title is cut to 60 characters", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const id = newPrivateChatId();
  const reply = await seedChat(store, id, "a long question");
  await new ChatTitles(store, new TitleLlm("a".repeat(100))).replied(reply);
  assert.equal((await store.webChat(id))?.title, "a".repeat(60));
});

test("quotes and a final full stop are not kept in the title", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const id = newPrivateChatId();
  const reply = await seedChat(store, id, "plan a trip to Lisbon in May");
  await new ChatTitles(store, new TitleLlm("\"Lisbon trip in May.\"")).replied(reply);
  assert.equal((await store.webChat(id))?.title, "Lisbon trip in May");
});

test("a failed call keeps the old title, and the next reply tries again", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const id = newPrivateChatId();
  const reply = await seedChat(store, id, "plan a trip to Lisbon in May");
  await new ChatTitles(store, new TitleLlm("", false, true)).replied(reply);
  assert.equal((await store.webChat(id))?.title, "plan a trip to Lisbon in May");
  assert.equal((await store.webChat(id))?.titleSource, "auto");
  await new ChatTitles(store, new TitleLlm("Lisbon trip in May")).replied(reply);
  assert.equal((await store.webChat(id))?.title, "Lisbon trip in May");
});

test("a long chat is titled from its first exchange", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const id = newPrivateChatId();
  const reply = await seedChat(store, id, "plan a trip to Lisbon in May");
  for (let n = 0; n < 40; n++) {
    await store.ingest({ id: `later-${n}`, server, channel: privateChannel(id), author: owner, authorName: "Alice", isBot: false, text: `later question ${n}`, timestamp: 10 + n, addressed: true });
  }
  const llm = new TitleLlm("Lisbon trip in May");
  await new ChatTitles(store, llm).replied(reply);
  assert.equal((await store.webChat(id))?.title, "Lisbon trip in May");
  assert.match(JSON.stringify(llm.prompts[0]?.inputs), /plan a trip to Lisbon in May/);
});

test("a title is tried at most three times per process, then left alone", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const id = newPrivateChatId();
  const reply = await seedChat(store, id, "plan a trip to Lisbon in May");
  const llm = new TitleLlm("Lisbon trip in May", false, true);
  const titles = new ChatTitles(store, llm);
  for (let attempt = 0; attempt < 3; attempt++) await titles.replied(reply);
  llm.fail = false;
  await titles.replied(reply);
  assert.equal((await store.webChat(id))?.titleSource, "auto");
  assert.equal((await store.webChat(id))?.title, "plan a trip to Lisbon in May");
});

test("the backfill titles chats newest first, and runs once", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const older = newPrivateChatId(), newer = newPrivateChatId();
  await seedChat(store, older, "older question", 5);
  await seedChat(store, newer, "newer question", 9);
  const llm = new TitleLlm("Some title");
  await new ChatTitles(store, llm).backfill();
  assert.equal((await store.webChat(older))?.titleSource, "model");
  assert.equal((await store.webChat(newer))?.titleSource, "model");
  assert.match(JSON.stringify(llm.prompts[0]?.inputs), /newer question/);

  const later = newPrivateChatId();
  await seedChat(store, later, "later question", 20);
  await new ChatTitles(store, new TitleLlm("Another title")).backfill();
  assert.equal((await store.webChat(later))?.titleSource, "auto");
});

test("a private (incognito) chat gets no title and no model call", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const llm = new TitleLlm("Should not be used");
  const reply: Message = { id: "reply-incognito", server, channel: incognitoChannel(newPrivateChatId()), author: "slopbot", isBot: true, text: "Hi", addressed: false };
  await new ChatTitles(store, llm).replied(reply);
  assert.equal(llm.prompts.length, 0);
});
