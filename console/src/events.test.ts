import type { EngineEnvelope, EngineEvent } from "@slopbot/contracts";
import { describe, expect, test } from "vitest";
import { applyEngineEvent, chatMessages, emptyChat, loadTurns, pendingSend, repliesOf, runTurnsOf, toKitMessage, unloadedReplies, withLoadedTurns, withPending, type BotMessage, type ChatState } from "./events";

const conversation = { server: "s1", channel: "c1" };
let seq = 0;
const envelope = (event: EngineEvent): EngineEnvelope => ({ seq: ++seq, at: 1, conversation, event });
const fold = (events: EngineEnvelope[], state: ChatState = emptyChat()) => events.reduce((s, e) => applyEngineEvent(s, e, "c1"), state);
const foldEvents = (events: EngineEvent[], state?: ChatState) => fold(events.map(envelope), state);
const message = (patch: Partial<BotMessage>): BotMessage => ({
  id: "m1", channel: "c1", author: "u", authorName: "Ada", username: null, avatarUrl: null, text: "hi", timestamp: 1000,
  editedAt: null, slopbot: false, runIds: [], used: false, ...patch,
});
const request = message({});
const reply = message({ id: "m2", text: "Done.", slopbot: true, runIds: ["r1"], turn: "m1", timestamp: 2000 });

const markup = '{"markup":"<Stack />"}';
/** One turn: thinking, a streamed show_ui call, a second show_ui call, text, and the saved reply. */
const turn: EngineEvent[] = [
  { type: "turn.start", turn: "m1" },
  { type: "round.start", turn: "m1", run: "r1" },
  { type: "thinking.delta", turn: "m1", run: "r1", text: "hmm" },
  { type: "tool.input", turn: "m1", run: "r1", call: "c1", name: "show_ui", text: markup.slice(0, 12) },
  { type: "tool.input", turn: "m1", run: "r1", call: "c1", name: "show_ui", text: markup.slice(12) },
  { type: "tool.input", turn: "m1", run: "r1", call: "c2", name: "show_ui", text: markup },
  { type: "tool.status", turn: "m1", call: "c1", name: "show_ui", status: "running", input: JSON.parse(markup) },
  { type: "tool.status", turn: "m1", call: "c1", name: "show_ui", status: "completed", input: JSON.parse(markup) },
  { type: "tool.status", turn: "m1", call: "c2", name: "show_ui", status: "failed", input: JSON.parse(markup), reason: "bad markup" },
  { type: "text.delta", turn: "m1", run: "r1", text: "Done." },
  { type: "turn.end", turn: "m1", status: "done" },
  { type: "message.upsert", message: reply },
];
const toolCalls = (messages: ReturnType<typeof chatMessages>) => messages.flatMap((m) => m.parts.filter((p) => p.type === "tool_call"));

describe("a turn as kit messages", () => {
  test("the same events give the same message live and loaded", async () => {
    const live = foldEvents(turn);
    const page = emptyChat([toKitMessage(reply, "c1")], repliesOf([reply]), runTurnsOf([reply]));
    const reloaded = withLoadedTurns(page, await loadTurns(page, ["m2"], {
      turnEvents: async () => turn.filter((e) => e.type !== "message.upsert"),
    }));
    const shown = chatMessages(live);
    expect(shown.map((m) => m.id)).toEqual(["m2"]);
    expect(shown[0]!.parts.map((p) => p.type)).toEqual(["thinking", "tool_call", "tool_call", "text"]);
    expect(chatMessages(reloaded)).toEqual(shown);
  });

  test("a live show_ui or show_widget call draws while its input streams, then from its full input", () => {
    const half = foldEvents(turn.slice(0, 4));
    const [streaming] = toolCalls(chatMessages(half));
    expect(streaming).toMatchObject({ status: "input", name: "show_ui", inputJson: markup.slice(0, 12) });
    const widget = foldEvents([
      { type: "round.start", turn: "m1", run: "r1" },
      { type: "tool.input", turn: "m1", run: "r1", call: "w1", name: "show_widget", text: '{"html":"<b>hi' },
    ]);
    expect(toolCalls(chatMessages(widget))[0]).toMatchObject({ status: "input", partialInput: { html: "<b>hi" } });
    const [done] = toolCalls(chatMessages(foldEvents(turn.slice(0, 8))));
    expect(done).toMatchObject({ status: "done", input: { markup: "<Stack />" } });
  });

  test("two calls of the same tool stay apart, and a replay of the events adds nothing", () => {
    const events = turn.map(envelope);
    const once = fold(events);
    const [first, second] = toolCalls(chatMessages(once));
    expect(first).toMatchObject({ status: "done" });
    expect(second).toMatchObject({ status: "error", error: "bad markup" });
    // The stream sends the saved events again after a reconnect; older ones are dropped.
    const replayed = fold(events.slice(2), once);
    expect(chatMessages(replayed)).toEqual(chatMessages(once));
    // Status updates of a call join its part; they never start another one.
    const again = foldEvents([turn[6]!, turn[7]!, turn[8]!], once);
    expect(toolCalls(chatMessages(again))).toHaveLength(2);
  });

  test("a child call follows its parent, whichever call came between", () => {
    const state = foldEvents([
      { type: "round.start", turn: "m1", run: "r1" },
      { type: "tool.status", turn: "m1", call: "p", name: "run_tools_code", status: "running" },
      { type: "tool.status", turn: "m1", call: "other", name: "web_search", status: "running" },
      { type: "tool.status", turn: "m1", call: "k", name: "bash", status: "completed", parent: "p" },
    ]);
    expect(toolCalls(chatMessages(state)).map((p) => p.name)).toEqual(["run_tools_code", "bash", "web_search"]);
  });
});

describe("loading a reply", () => {
  test("a page that joined mid-turn loads the whole turn once the reply is saved", async () => {
    const joined = foldEvents(turn.slice(2, 5));
    expect(chatMessages(joined).map((m) => m.id)).toEqual(["live:m1"]);
    const saved = foldEvents([turn[10]!, turn[11]!], joined);
    expect(chatMessages(saved).map((m) => m.id)).toEqual(["m2"]);
    expect(unloadedReplies(saved)).toEqual(["m2"]);
    const full = withLoadedTurns(saved, await loadTurns(saved, ["m2"], { turnEvents: async () => turn.slice(0, 11) }));
    expect(chatMessages(full)[0]!.parts.map((p) => p.type)).toEqual(["thinking", "tool_call", "tool_call", "text"]);
  });

  test("a reply with no live events asks for its turn once, and a failed load leaves it as it is", async () => {
    const state = emptyChat([], repliesOf([reply]), runTurnsOf([reply]));
    const saved = fold([envelope({ type: "message.upsert", message: reply })], state);
    expect(unloadedReplies(saved)).toEqual(["m2"]);
    const found = await loadTurns(saved, ["m2"], { turnEvents: async () => { throw new Error("offline"); } });
    expect(found.loaded).toEqual({});
    expect(chatMessages(withLoadedTurns(saved, found))[0]!.parts.map((p) => p.type)).toEqual(["text"]);
  });
});

describe("withPending", () => {
  const sent = pendingSend("hi", [], 0);
  const roles = (r: ReturnType<typeof withPending>) => r.messages.map((m) => `${m.id}:${m.status}`);

  test("shows the sent message and a thinking reply before the bot's events", () => {
    expect(roles(withPending([], sent))).toEqual(["pending:user:done", "pending:reply:streaming"]);
  });

  test("keeps the thinking reply after the bot's copy of the message, until the run starts", () => {
    const state = foldEvents([{ type: "message.upsert", message: request }]);
    const shown = withPending(chatMessages(state), sent);
    expect(roles(shown)).toEqual(["m1:done", "pending:reply:streaming"]);
    expect(shown.done).toBe(false);
  });

  test("is done once the reply starts", () => {
    const state = foldEvents([
      { type: "message.upsert", message: request },
      { type: "round.start", turn: "m1", run: "r1" },
    ]);
    const shown = withPending(chatMessages(state), sent);
    expect(shown.done).toBe(true);
    expect(shown.messages.some((m) => m.id.startsWith("pending:"))).toBe(false);
  });

  test("counts only messages after the send", () => {
    const earlier = chatMessages(foldEvents([{ type: "message.upsert", message: { ...request, slopbot: true } }]));
    expect(withPending(earlier, pendingSend("again", [], 1)).done).toBe(false);
  });
});
