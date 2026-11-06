import type { Message } from "agentic-ui-kit/core";
import { describe, expect, test } from "vitest";
import type { TranscriptMessage } from "../api-types";
import { emptyChat, chatMessages, type RunStep } from "../events";
import { applyTranscriptEvent, channelMessage, displayMessages, foldOfPart, foldUnused, markUsed, metaOf, unusedIds, type TranscriptEvent } from "./transcript";

const AT = Date.parse("2026-11-05T10:00:00Z");
const human: TranscriptMessage = {
  id: "m1", channel: "c1", author: "u1", authorName: "Ana", username: "ana", avatarUrl: "https://cdn.discordapp.com/avatars/u1/a.png",
  text: "hi", timestamp: AT, editedAt: null, slopbot: false, runIds: [], used: false,
};
const slopbot: TranscriptMessage = { ...human, id: "m2", author: "bot", authorName: "Slopbot", username: "slopbot", avatarUrl: null, text: "Hello", timestamp: AT + 1000, slopbot: true, runIds: ["r1"], used: true };
const VIEWER = "viewer";

describe("channelMessage", () => {
  test("another person's message is the left side with their name and Discord avatar", () => {
    const message = channelMessage(human, VIEWER, "c1");
    expect(message.role).toBe("assistant");
    expect(metaOf(message)).toMatchObject({ name: "Ana", username: "ana", avatarUrl: human.avatarUrl, mine: false, slopbot: false });
  });

  test("an avatar outside Discord's CDN is dropped, and the name falls back to the author id", () => {
    const message = channelMessage({ ...human, avatarUrl: "https://example.com/a.png", authorName: "" }, VIEWER, "c1");
    expect(metaOf(message)).toMatchObject({ avatarUrl: null, name: "u1" });
  });

  test("the viewer's own message is the user's turn", () => {
    const message = channelMessage({ ...human, author: VIEWER }, VIEWER, "c1");
    expect(message.role).toBe("user");
    expect(metaOf(message)).toMatchObject({ mine: true });
  });

  test("a Slopbot reply is named Slopbot and keeps its run IDs", () => {
    const message = channelMessage(slopbot, VIEWER, "c1");
    expect(message.role).toBe("assistant");
    expect(metaOf(message)).toMatchObject({ name: "Slopbot", slopbot: true, runIds: ["r1"] });
  });

  test("images are Discord's own URLs, not the bot's chat image route", () => {
    const src = "https://cdn.discordapp.com/attachments/1/2/cat.png";
    const message = channelMessage({ ...human, remoteImages: [{ src, name: "cat.png", size: 2048 }] }, VIEWER, "c1");
    const images = message.parts.filter((part) => part.type === "attachment");
    expect(images).toMatchObject([{ type: "attachment", name: "cat.png", size: 2048, url: src, mime: "image/*" }]);
    expect(JSON.stringify(images)).not.toContain("/api/chats/");
  });
});

describe("applyTranscriptEvent", () => {
  test("a message event adds the message with its author and images, and an edit does not repeat the image", () => {
    const image = { src: "https://cdn.discordapp.com/attachments/1/2/cat.png", name: "cat.png", size: 2048 };
    const created: TranscriptEvent = { type: "message", id: 1, data: { action: "upsert", message: { ...human, remoteImages: [image] } } };
    const edited: TranscriptEvent = { type: "message", id: 2, data: { action: "upsert", message: { ...human, text: "hi again", editedAt: AT + 5000, remoteImages: [image] } } };
    const once = applyTranscriptEvent(emptyChat(), created, "c1", VIEWER);
    const twice = applyTranscriptEvent(once, edited, "c1", VIEWER);
    const [message] = chatMessages(twice);
    expect(chatMessages(twice)).toHaveLength(1);
    expect(metaOf(message!)).toMatchObject({ name: "Ana", edited: true });
    expect(message!.parts.filter((part) => part.type === "attachment")).toHaveLength(1);
    expect(message!.parts.filter((part) => part.type === "text")).toMatchObject([{ text: "hi again" }]);
  });
});

describe("displayMessages", () => {
  const at = (minutes: number, author: string, id: string): TranscriptMessage => ({ ...human, id, author, authorName: author, timestamp: AT + minutes * 60_000 });
  const continuedOf = (messages: TranscriptMessage[]) => displayMessages(messages.map((m) => channelMessage(m, VIEWER, "c1")), new Map()).map((m) => metaOf(m)?.continued);

  test("a message from the same author within five minutes continues the group", () => {
    expect(continuedOf([at(0, "u1", "a"), at(1, "u1", "b"), at(2, "u2", "c"), at(3, "u2", "d")])).toEqual([false, true, false, true]);
  });

  test("a message after five minutes, or after another author, starts a new group", () => {
    expect(continuedOf([at(0, "u1", "a"), at(6, "u1", "b"), at(7, "u2", "c"), at(8, "u1", "d")])).toEqual([false, false, false, false]);
  });

  test("a Slopbot reply gets the steps of its runs before its text", () => {
    const steps: RunStep[] = [{ type: "tool", name: "web_search", status: "completed", args: '{"query":"cats"}', result: "ok" }];
    const [message] = displayMessages([channelMessage(slopbot, VIEWER, "c1")], new Map([["r1", steps]]));
    expect(message!.parts.map((part) => part.type)).toEqual(["custom", "tool_call", "text"]);
    expect(message!.parts[1]).toMatchObject({ type: "tool_call", name: "web_search", status: "done" });
  });
});

describe("foldUnused", () => {
  const other = (id: string, patch: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ ...human, id, author: "u2", authorName: "Bo", ...patch });
  const page = (items: TranscriptMessage[]) => displayMessages(items.map((m) => channelMessage(m, VIEWER, "c1")), new Map());
  /** The rows as the reader sees them: a fold row as "fold <count>", a message as its ID. A fold rides on the message under it. */
  const layout = (rows: Message[]) => rows.flatMap((row) => {
    const fold = foldOfPart(row.parts[0]!);
    const label = fold ? [`fold ${fold.count}${fold.open ? " open" : ""}`] : [];
    return row.id.startsWith("fold:") ? label : [...label, row.id];
  });

  test("unused messages from other people fold into one row, and a message a reply used breaks the run", () => {
    const rows = foldUnused(page([other("a"), other("b"), { ...slopbot, id: "reply", used: false }, other("c"), other("d", { used: true })]), [], new Set());
    expect(layout(rows)).toEqual(["fold 2", "reply", "fold 1", "d"]);
  });

  test("the viewer's own messages and Slopbot's never fold", () => {
    const rows = foldUnused(page([{ ...human, id: "mine", author: VIEWER }, { ...slopbot, id: "bot", used: false }]), [], new Set());
    expect(layout(rows)).toEqual(["mine", "bot"]);
  });

  test("a run's messages show after its row when the reader opens it", () => {
    const rows = foldUnused(page([other("a"), other("b")]), [], new Set(["a"]));
    expect(layout(rows)).toEqual(["fold 2 open", "a", "b"]);
  });

  test("nothing folds from the trigger of a live run onward", () => {
    const rows = foldUnused(page([other("a"), other("trigger"), other("c")]), ["trigger"], new Set());
    expect(layout(rows)).toEqual(["fold 1", "trigger", "c"]);
  });
});

describe("used refresh", () => {
  test("asks only about other people's unused messages, and a used one stops folding", () => {
    const other = channelMessage(human, VIEWER, "c1");
    const mine = channelMessage({ ...human, id: "m3", author: VIEWER }, VIEWER, "c1");
    const reply = channelMessage(slopbot, VIEWER, "c1");
    const list = [other, mine, reply];
    expect(unusedIds(list)).toEqual(["m1"]);
    const marked = markUsed(list, new Set(["m1"]));
    expect(metaOf(marked[0]!)?.used).toBe(true);
    expect(unusedIds(marked)).toEqual([]);
    expect(marked[1]).toBe(mine);
  });
});

describe("fold row placement", () => {
  test("the fold rides on the next message from someone else, so it gets no copy button and time of its own", () => {
    const other = (id: string, used = false): TranscriptMessage => ({ ...human, id, author: "u2", authorName: "Bo", used });
    const rows = foldUnused(displayMessages([other("a"), other("b", true)].map((m) => channelMessage(m, VIEWER, "c1")), new Map()), [], new Set());
    expect(rows.map((row) => row.id)).toEqual(["b"]);
    expect(foldOfPart(rows[0]!.parts[0]!)?.count).toBe(1);
  });
  test("before the viewer's own message the fold is a row of its own", () => {
    const rows = foldUnused(displayMessages([{ ...human, id: "a", author: "u2" }, { ...human, id: "m", author: VIEWER, used: true }].map((m) => channelMessage(m, VIEWER, "c1")), new Map()), [], new Set());
    expect(rows.map((row) => row.id)).toEqual(["fold:a:row", "m"]);
  });
});
