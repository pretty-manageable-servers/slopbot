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
  assert.ok((await f.store.context(observer, 10)).some(message => message.id === "external"));
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
  assert.throws(() => loadConfig({}), /DISCORD_GUILD_ID/);
});

test("task handoff carries the referenced profile rather than unrelated channel chat", async t => {
  const f=setup(); t.after(()=>f.store.close());
  await f.store.ingest({id:"profile",server:"s",channel:"c",author:"bot",text:"Rice Farmer (<@12345678901234567>) Discord identity",isBot:true});
  await f.store.ingest({id:"background",server:"s",channel:"c",author:"someone",text:"irrelevant weather"});
  const request=incoming("correction","his name is Oscar",{replyTo:"profile",repliesToBot:true});
  await f.store.ingest(request);
  await f.bot.startTask(request,request.text);
  const seed=f.store.canonicalMessage("s","task-seed:correction")!;
  assert.ok(seed.text.includes('"context_role":"reply_target"')&&seed.text.includes("Rice Farmer"));
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
