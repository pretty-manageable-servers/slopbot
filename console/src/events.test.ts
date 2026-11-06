import { describe, expect, test } from "vitest";
import { applyBotEvent, chatMessages, emptyChat, toKitMessage, withRunSteps, type BotEvent, type BotMessage, type ChatState } from "./events";

const fold = (events: BotEvent[], state: ChatState = emptyChat()) => events.reduce((s, e) => applyBotEvent(s, e, "c1"), state);
const request: BotMessage = { id: "m1", text: "hi", timestamp: 1000, slopbot: false, runIds: [] };

describe("applyBotEvent", () => {
  test("a live run streams thinking, a tool and text into one assistant message", () => {
    const state = fold([
      { type: "message", id: 1, data: { action: "upsert", message: request } },
      { type: "run.start", id: 2, data: { ref: "r1", requestId: "m1" } },
      { type: "run.delta", id: 3, data: { ref: "r1", part: "thinking", text: "Let me " } },
      { type: "run.delta", id: 4, data: { ref: "r1", part: "thinking", text: "look." } },
      { type: "run.tool", id: 5, data: { ref: "m1", requestId: "m1", id: "t1", name: "web_search", status: "running", args: '{"query":"x"}' } },
      { type: "run.tool", id: 6, data: { ref: "m1", requestId: "m1", id: "t1", name: "web_search", status: "completed", args: '{"query":"x"}' } },
      { type: "run.delta", id: 7, data: { ref: "r1", part: "text", text: "Hel" } },
      { type: "run.delta", id: 8, data: { ref: "r1", part: "text", text: "lo" } },
    ]);
    const [user, live] = chatMessages(state);
    expect(user).toMatchObject({ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] });
    expect(live).toMatchObject({ role: "assistant", status: "streaming", parentId: "m1" });
    expect(live!.parts.map((p) => [p.type, p.status])).toEqual([["thinking", "done"], ["tool_call", "done"], ["text", "streaming"]]);
    expect(live!.parts[0]).toMatchObject({ text: "Let me look." });
    expect(live!.parts[1]).toMatchObject({ name: "web_search", input: { query: "x" } });
    expect(live!.parts[2]).toMatchObject({ text: "Hello" });
  });

  test("a failed tool shows its reason as the error", () => {
    const state = fold([
      { type: "run.start", id: 1, data: { ref: "r1", requestId: "m1" } },
      { type: "run.tool", id: 2, data: { ref: "m1", requestId: "m1", id: "t1", name: "bash", status: "rejected", args: "{}", reason: "Denied" } },
    ]);
    expect(chatMessages(state)[0]!.parts[0]).toMatchObject({ type: "tool_call", status: "error", error: "Denied" });
  });

  test("the saved reply replaces the live message of its run", () => {
    const state = fold([
      { type: "run.start", id: 1, data: { ref: "r1", requestId: "m1" } },
      { type: "run.delta", id: 2, data: { ref: "r1", part: "text", text: "Hello" } },
      { type: "run.end", id: 3, data: { ref: "r1", status: "done" } },
      { type: "message", id: 4, data: { action: "upsert", message: { id: "m2", text: "Hello", timestamp: 2000, slopbot: true, runIds: ["r1"] } } },
    ], emptyChat());
    expect(chatMessages(state).map((m) => [m.id, m.role, m.status])).toEqual([["m2", "assistant", "done"]]);
  });

  test("a second run of the same request goes on in the same live message", () => {
    const state = fold([
      { type: "run.start", id: 1, data: { ref: "r1", requestId: "m1" } },
      { type: "run.delta", id: 2, data: { ref: "r1", part: "text", text: "a" } },
      { type: "run.end", id: 3, data: { ref: "r1", status: "failed" } },
      { type: "run.start", id: 4, data: { ref: "r2", requestId: "m1" } },
      { type: "run.delta", id: 5, data: { ref: "r2", part: "text", text: "b" } },
    ]);
    const live = chatMessages(state);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: "streaming", runId: "r2" });
    expect(live[0]!.parts.map((p) => "text" in p && p.text)).toEqual(["a", "b"]);
  });

  test("replayed and old events are dropped, and an edit and a delete apply", () => {
    let state = fold([{ type: "message", id: 5, data: { action: "upsert", message: request } }]);
    expect(fold([{ type: "message", id: 5, data: { action: "upsert", message: { ...request, text: "old" } } }], state)).toBe(state);
    state = fold([{ type: "message", id: 6, data: { action: "upsert", message: { ...request, text: "edited" } } }], state);
    expect(chatMessages(state)[0]!.parts).toMatchObject([{ text: "edited" }]);
    state = fold([{ type: "message", id: 7, data: { action: "delete", id: "m1" } }], state);
    expect(chatMessages(state)).toEqual([]);
  });

  test("saved images and files become attachments with their chat routes", () => {
    const state = fold([{ type: "message", id: 1, data: { action: "upsert", message: { ...request, images: [{ imageId: "i1", name: "a.png", contentType: "image/png", size: 3 }], files: [{ fileId: "f1", name: "b.pdf", contentType: "application/pdf", size: 4 }] } } }]);
    expect(chatMessages(state)[0]!.parts).toMatchObject([
      { type: "attachment", url: "/api/chats/c1/images/i1", mime: "image/png" },
      { type: "attachment", url: "/api/chats/c1/files/f1", name: "b.pdf" },
      { type: "text", text: "hi" },
    ]);
  });

  test("show_ui input streams into one tool part, which run.tool then runs and ends", () => {
    const state = fold([
      { type: "run.start", id: 1, data: { ref: "r1", requestId: "m1" } },
      { type: "run.delta", id: 2, data: { ref: "r1", part: "text", text: "Here:" } },
      { type: "run.delta", id: 3, data: { ref: "r1", part: "tool", index: 0, name: "show_ui", text: '{"markup":"<Card title=\\"Pl' } },
      { type: "run.delta", id: 4, data: { ref: "r1", part: "tool", index: 0, name: "show_ui", text: 'an\\" />"}' } },
      { type: "run.tool", id: 5, data: { ref: "m1", requestId: "m1", id: "turn1:0", name: "show_ui", status: "running", args: "{}" } },
      { type: "run.tool", id: 6, data: { ref: "m1", requestId: "m1", id: "turn1:0", name: "show_ui", status: "completed", args: "{}" } },
    ]);
    const live = chatMessages(state)[0]!;
    expect(live.parts.map((p) => [p.type, p.status])).toEqual([["text", "done"], ["tool_call", "done"]]);
    expect(live.parts[1]).toMatchObject({ name: "show_ui", input: { markup: '<Card title="Plan" />' } });
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
