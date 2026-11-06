import { describe, expect, test } from "vitest";
import { applyBotEvent, chatMessages, emptyChat, pendingSend, toKitMessage, withPending, withRunSteps, type BotEvent, type BotMessage, type ChatState } from "./events";

const fold = (events: BotEvent[], state: ChatState = emptyChat()) => events.reduce((s, e) => applyBotEvent(s, e, "c1"), state);
const request: BotMessage = { id: "m1", text: "hi", timestamp: 1000, slopbot: false, runIds: [] };

describe("applyBotEvent", () => {
  test("the saved reply replaces the live message of its run", () => {
    const state = fold([
      { type: "run.start", id: 1, data: { ref: "r1", requestId: "m1" } },
      { type: "run.delta", id: 2, data: { ref: "r1", part: "text", text: "Hello" } },
      { type: "run.end", id: 3, data: { ref: "r1", status: "done" } },
      { type: "message", id: 4, data: { action: "upsert", message: { id: "m2", text: "Hello", timestamp: 2000, slopbot: true, runIds: ["r1"] } } },
    ], emptyChat());
    expect(chatMessages(state).map((m) => [m.id, m.role, m.status])).toEqual([["m2", "assistant", "done"]]);
  });

  test("a second model turn starts a new part for the same tool index", () => {
    const state = fold([
      { type: "run.start", id: 1, data: { ref: "r1", requestId: "m1" } },
      { type: "run.delta", id: 2, data: { ref: "r1", part: "tool", index: 0, name: "show_ui", text: '{"markup":"<Stack />"}' } },
      { type: "run.tool", id: 3, data: { ref: "m1", requestId: "m1", id: "t1:0", name: "show_ui", status: "failed", args: "{}", reason: "bad" } },
      { type: "run.delta", id: 4, data: { ref: "r1", part: "tool", index: 0, name: "show_ui", text: '{"markup":"<Text text=\\"ok\\" />"}' } },
      { type: "run.tool", id: 5, data: { ref: "m1", requestId: "m1", id: "t2:0", name: "show_ui", status: "completed", args: "{}" } },
    ]);
    expect(chatMessages(state)[0]!.parts.map((p) => [p.status, "input" in p && p.input])).toEqual([
      ["error", { markup: "<Stack />" }],
      ["done", { markup: '<Text text="ok" />' }],
    ]);
  });

  test("the saved reply keeps the live thinking and tool parts before its text", () => {
    const state = fold([
      { type: "run.start", id: 1, data: { ref: "r1", requestId: "m1" } },
      { type: "run.delta", id: 2, data: { ref: "r1", part: "thinking", text: "hmm" } },
      { type: "run.delta", id: 3, data: { ref: "r1", part: "tool", index: 0, name: "show_ui", text: '{"markup":"<Stack />"}' } },
      { type: "run.tool", id: 4, data: { ref: "m1", requestId: "m1", id: "t:0", name: "show_ui", status: "completed", args: "{}" } },
      { type: "run.delta", id: 5, data: { ref: "r1", part: "text", text: "Done." } },
      { type: "run.end", id: 6, data: { ref: "r1", status: "done" } },
      { type: "message", id: 7, data: { action: "upsert", message: { id: "m2", text: "Done.", timestamp: 2000, slopbot: true, runIds: ["r1"] } } },
      { type: "message", id: 8, data: { action: "upsert", message: { id: "m2", text: "Done, edited.", timestamp: 2000, slopbot: true, runIds: ["r1"] } } },
    ]);
    const [reply] = chatMessages(state);
    expect(reply!.parts.map((p) => [p.type, "text" in p ? p.text : p.type === "tool_call" && p.name])).toEqual([
      ["thinking", "hmm"], ["tool_call", "show_ui"], ["text", "Done, edited."],
    ]);
  });

  test("a reply loaded later gets the thinking and tool steps of its runs, with the full show_ui input", () => {
    const reply = toKitMessage({ id: "m2", text: "Done.", timestamp: 1, slopbot: true, runIds: ["r1"] }, "c1");
    const out = withRunSteps(reply, [
      { type: "thinking", text: "hmm" },
      { type: "tool", name: "web_search", status: "completed", args: '{"query":"x"}', result: "3 results" },
      { type: "tool", name: "bash", status: "failed", args: '{"cmd":"ls', result: "Denied" },
      { type: "tool", name: "show_ui", status: "completed", args: '{"markup":"<St…', input: { markup: "<Stack />" } },
      { type: "text", text: "Done." },
    ]);
    expect(out.parts).toMatchObject([
      { type: "thinking", text: "hmm", status: "done" },
      { type: "tool_call", name: "web_search", input: { query: "x" }, result: "3 results", status: "done" },
      { type: "tool_call", name: "bash", input: '{"cmd":"ls', error: "Denied", status: "error" },
      { type: "tool_call", name: "show_ui", input: { markup: "<Stack />" } },
      { type: "text", text: "Done." },
    ]);
    expect(withRunSteps(out, [{ type: "thinking", text: "again" }])).toBe(out);
  });
});

describe("withPending", () => {
  const sent = pendingSend("hi", [], 0);
  const roles = (r: ReturnType<typeof withPending>) => r.messages.map((m) => `${m.id}:${m.status}`);

  test("shows the sent message and a thinking reply before the bot's events", () => {
    expect(roles(withPending([], sent))).toEqual(["pending:user:done", "pending:reply:streaming"]);
  });

  test("keeps the thinking reply after the bot's copy of the message, until the run starts", () => {
    const state = fold([{ type: "message", id: 1, data: { action: "upsert", message: request } } as BotEvent]);
    const shown = withPending(chatMessages(state), sent);
    expect(roles(shown)).toEqual(["m1:done", "pending:reply:streaming"]);
    expect(shown.done).toBe(false);
  });

  test("is done once the reply starts", () => {
    const state = fold([
      { type: "message", id: 1, data: { action: "upsert", message: request } },
      { type: "run.start", id: 2, data: { ref: "r1", requestId: "m1" } },
    ] as BotEvent[]);
    const shown = withPending(chatMessages(state), sent);
    expect(shown.done).toBe(true);
    expect(shown.messages.some((m) => m.id.startsWith("pending:"))).toBe(false);
  });

  test("counts only messages after the send", () => {
    const earlier = chatMessages(fold([{ type: "message", id: 1, data: { action: "upsert", message: { ...request, slopbot: true } } } as BotEvent]));
    expect(withPending(earlier, pendingSend("again", [], 1)).done).toBe(false);
  });
});
