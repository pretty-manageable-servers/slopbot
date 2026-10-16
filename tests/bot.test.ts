import assert from "node:assert/strict";
import { test } from "node:test";
import { Application } from "../src/application.js";
import { Bot, splitReply, type ChatGateway, type Incoming } from "../src/bot.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { loadConfig } from "../src/config.js";

const incoming = (id: string, text: string, extra: Partial<Incoming> = {}): Incoming => ({
  id, server: "s", channel: "c", author: "alice", text,
  botAuthor: false, mentionsBot: false, repliesToBot: false, ...extra,
});

test('empty requests do not call the model or queue a task, while attachment-only requests do', async t => {
  const store = new SQLiteStore(); t.after(() => store.close()); let models = 0; let jobs = 0;
  const app = new Application(store, { async *stream() { models++; yield { kind: 'text', payload: { text: 'Attachment received' } }; } }, { allowedChannels: [{ server: 's', channel: 'c' }] });
  const gateway: ChatGateway = { async reply() { return []; }, async createTaskThread() { throw new Error('No thread expected'); }, typing() { return () => {}; } };
  const bot = new Bot(app, store, store, gateway, 's', ['c']);
  await bot.receive(incoming('empty', '   ', { mentionsBot: true }));
  assert.equal(models, 0); assert.equal((await store.jobs('s', 'c')).length, 0);
  assert.equal(await app.handle({ id: 'direct-empty', server: 's', channel: 'c', author: 'alice', text: '', addressed: true }), undefined);
  await bot.receive(incoming('attachment', '', { mentionsBot: true, attachments: [{ name: 'plot.png', url: 'https://cdn.discordapp.com/plot.png' }] }));
  assert.equal(models, 1);
  const queued = incoming('queued', 'old goal', { addressed: true });
  await store.ingest(queued); await store.revise({ ...queued, text: '' });
  assert.equal(await app.handle(queued, true), undefined); assert.equal(models, 1);
  jobs = (await store.jobs('s', 'c')).length; assert.equal(jobs, 0);
});

function setup() {
  const store = new SQLiteStore();
  const llm = new FakeLLM();
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] });
  const outputs: { channel: string; text: string }[] = [];
  let created = 0;
  const gateway: ChatGateway = {
    async reply(message, text) {
      outputs.push({ channel: message.channel, text });
      return [{ id: `out:${outputs.length}`, server: "s", channel: message.channel, author: "bot", text }];
    },
    async createTaskThread() { created++; return "thread"; },
    typing() { return () => undefined; },
  };
  const bot = new Bot(app, store, store, gateway, "s", ["c"]);
  return { store, llm, app, bot, outputs, gateway, created: () => created };
}

test("ordinary chat is stored silently; mentions and bot replies get answers", async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.bot.receive(incoming("1", "ordinary chat"));
  assert.equal(f.outputs.length, 0);
  await f.bot.receive(incoming("2", "hello", { mentionsBot: true }));
  await f.bot.receive(incoming("3", "continue", { repliesToBot: true }));
  assert.equal(f.outputs.length, 2);
  assert.ok(JSON.stringify(f.llm.prompts[0]).includes("ordinary chat"));
});

test("task command creates one thread and subsequent contributions continue its history", async t => {
  const f = setup(); t.after(() => f.store.close());
  const request = incoming("1", "!task plan dinner", { mentionsBot: true });
  await f.bot.receive(request);
  await f.bot.receive(request);
  assert.equal(f.created(), 1);
  assert.equal(f.outputs[0]?.channel, "thread");
  await Promise.all([
    f.bot.receive(incoming("2", "vegetarian", { channel: "thread" })),
    f.bot.receive(incoming("3", "$200", { channel: "thread", author: "bob" })),
  ]);
  assert.equal(f.llm.prompts[2]?.history.length, 4);
  assert.equal(f.llm.prompts[2]?.inputs.at(-1)?.author, "bob");
});

test("task mapping survives reconstructing the bot", async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.bot.receive(incoming("1", "!task goal", { mentionsBot: true }));
  const bot = new Bot(f.app, f.store, f.store, f.gateway, "s", ["c"]);
  await bot.receive(incoming("2", "continue", { channel: "thread" }));
  assert.equal(f.llm.prompts[1]?.history.length, 2);
});

test("other bots can mention and reply to Slopbot; unconfigured channels remain ignored", async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.bot.receive(incoming("1", "hello", { botAuthor: true, mentionsBot: true }));
  await f.bot.receive(incoming("2", "hello", { channel: "private", mentionsBot: true }));
  await f.bot.receive(incoming("3", "continue", { author: "other-bot", botAuthor: true, repliesToBot: true }));
  assert.equal(f.llm.prompts.length, 2);
});

test("unaddressed bots are stored once as context", async t => {
  const f = setup(); t.after(() => f.store.close());
  const automated = incoming("external", "app deployment succeeded", { author: "other-bot", botAuthor: true });
  await f.bot.receive(automated);
  await f.bot.receive(automated);
  assert.equal(f.created(), 0);
  assert.equal(f.outputs.length, 0);
  const observer = incoming("observer", "ordinary chat");
  await f.bot.receive(observer);
  const context = await f.store.context(observer, 10);
  assert.equal(context.filter(message => message.id === "external").length, 1);
  assert.equal(context.find(message => message.id === "external")?.isBot, true);
  await f.bot.receive(incoming("human", "what happened?", { mentionsBot: true, replyTo: "external" }));
  assert.ok(JSON.stringify(f.llm.prompts[0]).includes("app deployment succeeded"));
});

test("other bots in task threads continue the task", async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.bot.receive(incoming("start", "!task plan", { mentionsBot: true }));
  const count = f.llm.prompts.length;
  await f.bot.receive(incoming("external", "continue", { channel: "thread", botAuthor: true, repliesToBot: true }));
  assert.equal(f.llm.prompts.length, count + 1);
  const observer = incoming("observer", "status", { channel: "thread", botAuthor: true });
  await f.bot.receive(observer);
  assert.equal(f.llm.prompts.length, count + 1);
  assert.ok((await f.store.context(observer, 10)).some(message => message.id === "external"));
});

test('unaddressed bot error commentary cannot enqueue task work or trigger participation', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.bot.receive(incoming('start', '!task plan', { mentionsBot: true }));
  let enqueued = 0, decisions = 0;
  const { ParticipationGate } = await import('../src/participation.js');
  const participation = new ParticipationGate({ classify: async () => {
    decisions++; return { respond: true, addressed: true, reason: 'continue' };
  } }, { enabled: true, contextMessages: 10, cooldownMs: 0, maxUnsolicitedPerHour: 10 });
  const worker = { enqueue: async () => { enqueued++; } } as unknown as import('../src/queue.js').TaskWorker;
  const bot = new Bot(f.app, f.store, f.store, f.gateway, 's', ['c'], { participation, worker });
  await bot.receive(incoming('comment', 'Same CHECKPOINT_INVALID failure. Stop retrying.', { channel: 'thread', author: 'other-bot', botAuthor: true }));
  assert.equal(enqueued, 0); assert.equal(decisions, 0);
  assert.ok((await f.store.canonicalMessage('s', 'comment'))?.isBot);
  await bot.receive(incoming('collaborate', 'Review my contribution', { channel: 'thread', author: 'other-bot', botAuthor: true, mentionsBot: true }));
  await bot.receive(incoming('human', 'Continue', { channel: 'thread' }));
  assert.equal(enqueued, 2);
});

test("source edits invalidate copied task context but preserve reasoning events", async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.bot.receive(incoming("1", "!task old goal", { mentionsBot: true }));
  await f.store.revise(incoming("1", "!task corrected goal"));
  await f.bot.receive(incoming("2", "new goal", { channel: "thread" }));
  assert.deepEqual(f.llm.prompts[1]?.history, []);
});

test("reply splitting keeps surrogate pairs intact and stays under Discord's limit", () => {
  const text = "🙂".repeat(3000);
  const chunks = splitReply(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every(chunk => chunk.length <= 1900));
});

test("reply splitting moves a whole sentence to the next message", () => {
  const first = "This sentence fits. ", second = "The next sentence stays whole.";
  assert.deepEqual(splitReply(first + second, 35), [first, second]);
});

test("reply splitting preserves paragraph whitespace and quoted sentences", () => {
  const first = 'She said, "Keep this together."\n\n';
  const second = "The next paragraph stays whole.";
  assert.deepEqual(splitReply(first + second, 40), [first, second]);
});

test("oversized sentences split at words without losing text", () => {
  const text = "These words form a sentence longer than one message can hold.";
  const chunks = splitReply(text, 25);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every(chunk => chunk.length <= 25));
  assert.ok(chunks.slice(0, -1).every(chunk => /\s$/.test(chunk)));
});

test("code lines stay together across reply pages", () => {
  const text = "```js\nconst first = 1;\nconst second = 2;\n```";
  const chunks = splitReply(text, 35);
  assert.deepEqual(chunks, ["```js\nconst first = 1;\n\n```", "```js\nconst second = 2;\n```"]);
});

test("embed-only updates do not invalidate task history", async t => {
  const f = setup(); t.after(() => f.store.close());
  const request = incoming("1", "!task goal", { mentionsBot: true });
  await f.bot.receive(request);
  await f.store.revise(request);
  await f.bot.receive(incoming("2", "continue", { channel: "thread" }));
  assert.equal(f.llm.prompts[1]?.history.length, 2);
});

test("mock config requires Discord details but no AI key", () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: "test-only", DISCORD_GUILD_ID: "123456789012345678",
    DISCORD_CHANNEL_IDS: "223456789012345678", LLM_MODE: "mock",
  });
  assert.equal(config.model, "nimbus");
  assert.equal(config.apiKey, "");
  assert.throws(() => loadConfig({}), /DISCORD_BOT_TOKEN/);
  assert.throws(() => loadConfig({ DISCORD_BOT_TOKEN: "test-only", DISCORD_CHANNEL_IDS: "223456789012345678", LLM_MODE: "mock" }), /DISCORD_GUILD_ID/);
});

test("task handoff carries the referenced profile rather than unrelated channel chat", async t => {
  const f=setup(); t.after(()=>f.store.close());
  await f.store.ingest({id:"profile",server:"s",channel:"c",author:"bot",text:"Rice Farmer (<@12345678901234567>) Discord identity",isBot:true});
  await f.store.ingest({id:"background",server:"s",channel:"c",author:"someone",text:"irrelevant weather"});
  const request=incoming("correction","his name is Oscar",{replyTo:"profile",repliesToBot:true});
  await f.store.ingest(request);
  await f.bot.startTask(request,request.text);
  const seed=f.store.canonicalMessage("s","task-seed:correction")!;
  assert.ok(seed.text.includes("[reply target]")&&seed.text.includes("Rice Farmer"));
  assert.ok(!seed.text.includes("irrelevant weather"));
  assert.ok(f.llm.prompts[0]?.inputs.some(item=>item.content.includes("Rice Farmer")));
});

test('quick inline writes stay in the channel while sustained writes use a task thread',async t=>{
 const {ToolRegistry}=await import('../src/tools.js');const f=setup();t.after(()=>f.store.close());
 const tools=new ToolRegistry(f.store,async()=>false);let executed=0;
 tools.register({name:'quick_write',description:'Quick action',fields:{},access:'member',effect:'write',retrySafe:true,execution:'inline',execute:async()=>{executed++;return 'Done';}});
 tools.register({name:'long_write',description:'Long action',fields:{},access:'member',effect:'write',retrySafe:true,execute:async()=>{throw Error('must move');}});
 const bot=new Bot(f.app,f.store,f.store,f.gateway,'s',['c'],{tools});
 const request=incoming('inline','do it');await f.store.ingest(request);
 const result=await bot.executeTool(request,{name:'quick_write',arguments:{}},'quick');assert.equal(result.text,'Done');assert.equal(executed,1);assert.equal(f.created(),0);
 const handoff=await bot.executeTool(request,{name:'long_write',arguments:{}},'long');assert.equal(handoff.handoff?.threadId,'thread');assert.equal(f.created(),1);
});


test('long tool argument blocks keep code fences balanced across Discord messages', () => {
  const text = 'Answer\n\n```json\n' + JSON.stringify({command:'🙂'.repeat(3000)}) + '\n```\nAfter';
  const chunks = splitReply(text);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1900);
    assert.equal((chunk.match(/```/g) ?? []).length % 2, 0);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
  }
  assert.equal(chunks.join('').replace(/\n``````json\n/g, ''), text);
});

// A run whose tool call changes the chat once. The reply path must still deliver, unless the request itself is deleted.
async function changedRun(t: { after(fn: () => void): void }, change: (store: SQLiteStore) => Promise<void>) {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.ingest({ id: "other", server: "s", channel: "c", author: "bob", text: "Unrelated message.", timestamp: 1 });
  let rounds = 0, changed = false;
  const llm = { async *stream() { if (++rounds === 1) yield { kind: "tool_call", payload: [{ name: "read_one", arguments: {} }] }; else yield { kind: "text", payload: { text: "Answer after the change." } }; } };
  const app = new Application(store, llm as never, { allowedChannels: [{ server: "s", channel: "c" }] }, undefined, {
    tools: { schemas: () => [], catalog: () => "", execute: async () => { if (!changed) { changed = true; await change(store); } return { text: "Read finished.", status: "ok" }; } },
  });
  const outputs: string[] = [];
  const gateway: ChatGateway = {
    async reply(message, text) { outputs.push(text); return [{ id: `out:${outputs.length}`, server: "s", channel: message.channel, author: "bot", text }]; },
    async createTaskThread() { return "thread"; },
    typing() { return () => undefined; },
  };
  const bot = new Bot(app, store, store, gateway, "s", ["c"]);
  await bot.receive(incoming("req", "hello", { mentionsBot: true }));
  return outputs;
}

test("a chat change during a run still delivers the answer", async t => {
  const outputs = await changedRun(t, store => store.remove("s", "c", "other"));
  assert.deepEqual(outputs, ["Answer after the change."]);
});

test("a request deleted during its run gets no answer", async t => {
  const outputs = await changedRun(t, store => store.remove("s", "c", "req"));
  assert.deepEqual(outputs, []);
});

test("request_uploads_files: a mention, a reply or a name request is marked for upload", async t => {
  const f = setup(); t.after(() => f.store.close());
  const queued: { id: string; uploadFiles?: true }[] = [];
  const worker = { enqueue: async (message: { id: string; uploadFiles?: true }) => { queued.push(message); } } as unknown as import("../src/queue.js").TaskWorker;
  const bot = new Bot(f.app, f.store, f.store, f.gateway, "s", ["c"], { worker });
  const file = { name: "report.pdf", url: "https://cdn.discordapp.com/attachments/1/report.pdf", contentType: "application/pdf", size: 10 };
  await bot.receive(incoming("mention", "@slop summarize", { mentionsBot: true, attachments: [file] }));
  await bot.receive(incoming("reply", "what is in it", { repliesToBot: true, attachments: [file] }));
  assert.deepEqual(queued.map(message => [message.id, message.uploadFiles]), [["mention", true], ["reply", true]]);
});

test("non_request_no_upload: an unsolicited reply to a file is not marked for upload", async t => {
  const f = setup(); t.after(() => f.store.close());
  const queued: { id: string; uploadFiles?: true }[] = [];
  const worker = { enqueue: async (message: { id: string; uploadFiles?: true }) => { queued.push(message); } } as unknown as import("../src/queue.js").TaskWorker;
  const { ParticipationGate } = await import("../src/participation.js");
  const participation = new ParticipationGate({ classify: async () => ({ respond: true, addressed: false, reason: "unsolicited_allowed" }) }, { enabled: true, contextMessages: 10, cooldownMs: 0, maxUnsolicitedPerHour: 10 });
  const bot = new Bot(f.app, f.store, f.store, f.gateway, "s", ["c"], { participation, worker });
  const file = { name: "report.pdf", url: "https://cdn.discordapp.com/attachments/1/report.pdf", contentType: "application/pdf", size: 10 };
  await bot.receive(incoming("unsolicited", "Interesting chart", { attachments: [file] }));
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.uploadFiles, undefined);
});
