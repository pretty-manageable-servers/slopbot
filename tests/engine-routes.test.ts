import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@slopbot/contracts";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";
import { ChatCompletionsLLM } from "../src/adapters/chat-completions.js";
import { ChannelAccess } from "../src/channel-access.js";
import { engineEvents } from "../src/engine/event-log.js";
import { runEvents, publishTool } from "../src/run-events.js";
import { webTranscriptKey } from "../src/server-tools.js";
import { createConsole } from "../src/web-console.js";
import { createChatRoutes, WebChatService, type ChatHost } from "../src/web-chats.js";
import { createTranscripts, legacyTurnEvents } from "../src/web-transcripts.js";
import { transcriptServer } from "./transcript-server.js";
import type { Message, ModelEvent, Prompt } from "../src/domain.js";

const SERVER = "1528063444874432734", CHANNEL = "1528063444874432735", ALICE = "1514413259522838529", BOB = "1514413259522838530";
const ORIGIN = "http://localhost:3000";
const NEXT_DIR = mkdtempSync(join(tmpdir(), "slopbot-engine-routes-"));
writeFileSync(join(NEXT_DIR, "share.html"), "<!doctype html><html><body><div id=\"root\"></div><!--share-data--></body></html>");

/** A real store behind the chat routes and the transcript routes, with a fake Discord host. */
async function setup(t: TestContext) {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  runEvents.attach(store);
  engineEvents.attach(store);
  t.after(() => engineEvents.attach(undefined as never));
  store.setSetting(SERVER, webTranscriptKey(CHANNEL), true);
  const host: ChatHost = {
    async member(user, server) { return server === SERVER && (user === ALICE || user === BOB); },
    async handle() { return { openChat() {}, closeChat() {}, async receiveChat() {}, async stopResponses() { return []; }, async act() { throw new Error("no cards"); } }; },
    limiter: { async check() { return { allowed: true }; } },
    access: new ChannelAccess({ async facts() { return { thread: false, privateThread: false, viewChannel: true, readMessageHistory: true, sendMessages: true, sendMessagesInThreads: true, threadMember: false }; } }),
  };
  const service = new WebChatService(store, host);
  const logins: Record<string, { cookie: string; csrf: string }> = {};
  for (const user of [ALICE, BOB]) {
    const id = randomBytes(32).toString("hex");
    await store.saveSession({ id_hash: createHash("sha256").update(id).digest("hex"), user_id: user, csrf: `csrf-${user}`, expires: Date.now() + 86_400_000, created: Date.now() });
    logins[user] = { cookie: `slopbot_session=${id}`, csrf: `csrf-${user}` };
  }
  const conversations = createTranscripts({ store, access: host.access, configured: () => [CHANNEL], channelName: async () => "general" });
  const web = createConsole({ origin: ORIGIN, host: "127.0.0.1", port: 3000, clientId: "id", clientSecret: "secret", nextDir: NEXT_DIR }, {
    sessions: store, async canSignIn() { return true; }, async snapshot() { return {}; }, async invoke() { return {}; },
    chats: createChatRoutes(service), conversations,
  } as never);
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(() => new Promise<void>(resolve => { web.closeAllConnections(); web.close(() => resolve()); }));
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const base = `http://127.0.0.1:${address.port}`;
  const get = async (user: string, path: string) => {
    const response = await fetch(base + path, { headers: { Cookie: logins[user]!.cookie } });
    return { status: response.status, json: await response.json() as any };
  };
  const post = async (user: string, path: string, body: unknown) => {
    const response = await fetch(base + path, { method: "POST", headers: { Cookie: logins[user]!.cookie, Origin: ORIGIN, "X-CSRF-Token": logins[user]!.csrf, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as any };
  };
  return { store, base, get, post, cookie: (user: string) => logins[user]!.cookie, transcripts: transcriptServer(conversations) };
}

/** A run saved before the engine log existed: a thinking step, one tool call with its result, and the reply text. */
async function saveOldRun(store: SQLiteStore, channel: string, turn: string) {
  const request: Message = { id: turn, server: SERVER, channel, author: ALICE, authorName: "Ada", text: "look it up", timestamp: 1000 };
  await store.startRun("run-old", request, { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" });
  const events: ModelEvent[] = [
    { kind: "reasoning", payload: { reasoning_content: "hmm" } },
    { kind: "tool_call", payload: [{ name: "lookup", arguments: { query: "x" }, id: "c1" }] },
    { kind: "text", payload: { text: "Done." } },
  ];
  for (const [index, event] of events.entries()) await store.appendEvent("run-old", index, event);
  const saved = store.addAgentTurn(request, "calling", [{ name: "lookup", arguments: { query: "x" }, id: "c1" }]);
  store.agentResult(saved.id, 0, { text: "3 results", status: "ok" });
  await store.complete("run-old", undefined, [], "Done.");
}

test("an old turn with no saved rows loads as events made from its runs; a turn with rows loads those rows", async t => {
  const f = await setup(t);
  const created = await f.post(ALICE, "/api/chats", { server: SERVER });
  const id = created.json.id as string, channel = `web:${id}`;
  await saveOldRun(f.store, channel, "m-old");
  const old = await f.get(ALICE, `/api/chats/${id}/turns/m-old/events`);
  assert.equal(old.status, 200);
  assert.deepEqual(old.json.events, [
    { type: "turn.start", turn: "m-old" },
    { type: "round.start", turn: "m-old", run: "run-old" },
    { type: "thinking.delta", turn: "m-old", run: "run-old", text: "hmm" },
    { type: "tool.status", turn: "m-old", call: "run-old:1", name: "lookup", status: "completed", input: { query: "x" }, result: "3 results" },
    { type: "text.delta", turn: "m-old", run: "run-old", text: "Done." },
    { type: "turn.end", turn: "m-old", status: "done" },
  ]);

  engineEvents.publish({ server: SERVER, channel }, { type: "turn.start", turn: "m-new" });
  engineEvents.publish({ server: SERVER, channel }, { type: "text.delta", turn: "m-new", run: "r1", text: "Hi" });
  await engineEvents.idle();
  assert.deepEqual((await f.get(ALICE, `/api/chats/${id}/turns/m-new/events`)).json.events, [
    { type: "turn.start", turn: "m-new" }, { type: "text.delta", turn: "m-new", run: "r1", text: "Hi" },
  ]);
  assert.equal((await f.get(ALICE, `/api/chats/${id}/turns/missing/events`)).status, 404);
  // Only the owner can read a chat's turns.
  assert.equal((await f.get(BOB, `/api/chats/${id}/turns/m-new/events`)).status, 404);
});

test("the conversation turn route loads an old turn from its runs and refuses a turn of another channel", async t => {
  const f = await setup(t);
  const server = f.transcripts;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const url = (channel: string, turn: string) => `http://127.0.0.1:${address.port}/api/conversations/${channel}/turns/${turn}/events?server=${SERVER}`;
  await saveOldRun(f.store, CHANNEL, "m-old");
  const found = await fetch(url(CHANNEL, "m-old"), { headers: { "x-user": ALICE } });
  assert.equal(found.status, 200);
  assert.equal(((await found.json()) as any).events.at(-1).type, "turn.end");
  assert.equal((await fetch(url("1528063444874432999", "m-old"), { headers: { "x-user": ALICE } })).status, 403);
  assert.equal((await fetch(url(CHANNEL, "m-old"))).status, 403);
});

test("the chat events stream replays saved events after ?after= and sends live ones with their seq", async t => {
  const f = await setup(t);
  const id = (await f.post(ALICE, "/api/chats", { server: SERVER })).json.id as string, channel = `web:${id}`;
  engineEvents.publish({ server: SERVER, channel }, { type: "turn.start", turn: "m1" });
  await engineEvents.idle();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${f.base}/api/chats/${id}/events?after=0`, { headers: { Cookie: f.cookie(ALICE) }, signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader(), decoder = new TextDecoder();
  let seen = "";
  const until = async (pattern: RegExp) => {
    while (!pattern.test(seen)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream ended early");
      seen += decoder.decode(chunk.value, { stream: true });
    }
  };
  await until(/event: engine\ndata: .*"turn.start"/);
  engineEvents.publish({ server: SERVER, channel }, { type: "text.delta", turn: "m1", run: "r1", text: "live" });
  await until(/id: \d+\nevent: engine\ndata: .*"text":"live"/);
  controller.abort();
  const other = await fetch(`${f.base}/api/chats/${id}/events`, { headers: { Cookie: f.cookie(BOB) } });
  assert.equal(other.status, 404);
});

test("a provider that sends no call ID: streamed tool input and the tool status share one call ID, and a child names its parent's call ID", async t => {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  runEvents.attach(store);
  engineEvents.attach(store);
  t.after(() => engineEvents.attach(undefined as never));
  store.setSetting("s", webTranscriptKey("c"), true);
  const response = (chunks: unknown[]) => new Response(chunks.map(choice => `data: ${JSON.stringify({ choices: [choice] })}\n\n`).join("") + "data: [DONE]\n\n");
  let calls = 0;
  const provider = new ChatCompletionsLLM({ baseUrl: "https://example.com/v1", apiKey: "test", model: "test" }, async () => ++calls === 1
    ? response([
      { index: 0, delta: { tool_calls: [{ index: 0, function: { name: "show_ui", arguments: '{"markup":' } }] } },
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"<Stack />"}' } }] }, finish_reason: "tool_calls" },
    ])
    : response([{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }]));
  // With no tools offered the provider need not send call IDs.
  const tools = { schemas: () => [], catalog: () => "", execute: async () => "ok" };
  const llm = { async *stream(prompt: Prompt) { yield* provider.stream(prompt); } };
  const request = { server: "s", channel: "c", taskId: "c", id: "request", author: "alice", text: "draw", addressed: true };
  await new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, undefined, { harness: store, tools, onToolActivity: async (message, activity) => publishTool(message, activity) }).handle(request);
  await engineEvents.idle();
  const events = await engineEvents.turn({ server: "s", channel: "c" }, "request");
  const input = events.filter(event => event.type === "tool.input"), status = events.filter(event => event.type === "tool.status");
  assert.equal(input.map(event => event.text).join(""), '{"markup":"<Stack />"}');
  assert.match(input[0]!.call, /^call_/);
  assert.deepEqual([...new Set([...input, ...status].map(event => event.call))], [input[0]!.call]);
});

test("a child tool.status names its parent by the parent's tool.status call ID", async t => {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  runEvents.attach(store);
  engineEvents.attach(store);
  t.after(() => engineEvents.attach(undefined as never));
  store.setSetting("s", webTranscriptKey("c"), true);
  const request = { id: "m1", server: "s", channel: "c", author: "a", text: "x" } as Message;
  publishTool(request, { id: "m1:0", callId: "call_p", name: "run_tools_code", status: "running", arguments: {} });
  publishTool(request, { id: "child", name: "bash", status: "completed", arguments: {}, parentId: "m1:0" });
  publishTool(request, { id: "m1:0", callId: "call_p", name: "run_tools_code", status: "completed", arguments: {} });
  await engineEvents.idle();
  const events = await engineEvents.turn({ server: "s", channel: "c" }, "m1");
  const child = events.find(event => event.type === "tool.status" && event.name === "bash");
  assert.equal(child?.type === "tool.status" && child.parent, "call_p");
});

test("legacyTurnEvents keeps run_tools_code children under their parent and ends a failed run as failed", () => {
  const events: EngineEvent[] = legacyTurnEvents("m1", [{ id: "r1", failed: true, steps: [
    { type: "tool", name: "run_tools_code", status: "completed", args: "{}", code: "go()", children: [{ type: "tool", name: "bash", status: "failed", args: "", parentId: "x" }] },
  ] }]);
  const parent = events.find(event => event.type === "tool.status" && event.name === "run_tools_code");
  const child = events.find(event => event.type === "tool.status" && event.name === "bash");
  assert.equal(child?.type === "tool.status" && child.parent, parent?.type === "tool.status" && parent.call);
  assert.deepEqual(events.at(-1), { type: "turn.end", turn: "m1", status: "failed" });
});
