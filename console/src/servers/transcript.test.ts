import type { Message } from "agentic-ui-kit/core";
import { describe, expect, test } from "vitest";
import type { TranscriptMessage } from "../api-types";
import type { EngineEnvelope } from "@slopbot/contracts";
import { emptyChat, chatMessages } from "../events";
import { applyTranscriptEvent, channelMessage, displayMessages, foldOfPart, foldUnused, markUsed, metaOf, unusedIds } from "./transcript";

const AT = Date.parse("2026-11-05T10:00:00Z");
const human: TranscriptMessage = {
  id: "m1", channel: "c1", author: "u1", authorName: "Ana", username: "ana", avatarUrl: "https://cdn.discordapp.com/avatars/u1/a.png",
  text: "hi", timestamp: AT, editedAt: null, slopbot: false, runIds: [], used: false,
};
const slopbot: TranscriptMessage = { ...human, id: "m2", author: "bot", authorName: "Slopbot", username: "slopbot", avatarUrl: null, text: "Hello", timestamp: AT + 1000, slopbot: true, runIds: ["r1"], used: true };
const VIEWER = "viewer";
const conversation = { server: "s1", channel: "c1" };

describe("channelMessage", () => {
  test("an avatar outside Discord's CDN is dropped, and the name falls back to the author id", () => {
    const message = channelMessage({ ...human, avatarUrl: "https://example.com/a.png", authorName: "" }, VIEWER, "c1");
    expect(metaOf(message)).toMatchObject({ avatarUrl: null, name: "u1" });
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
    const created: EngineEnvelope = { seq: 1, at: 1, conversation, event: { type: "message.upsert", message: { ...human, remoteImages: [image] } } };
    const edited: EngineEnvelope = { seq: 2, at: 2, conversation, event: { type: "message.upsert", message: { ...human, text: "hi again", editedAt: AT + 5000, remoteImages: [image] } } };
    const once = applyTranscriptEvent(emptyChat(), created, "c1", VIEWER);
    const twice = applyTranscriptEvent(once, edited, "c1", VIEWER);
    const [message] = chatMessages(twice);
    expect(chatMessages(twice)).toHaveLength(1);
    expect(metaOf(message!)).toMatchObject({ name: "Ana", edited: true });
    expect(message!.parts.filter((part) => part.type === "attachment")).toHaveLength(1);
    expect(message!.parts.filter((part) => part.type === "text")).toMatchObject([{ text: "hi again" }]);
  });
});

describe("foldUnused", () => {
  const other = (id: string, patch: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ ...human, id, author: "u2", authorName: "Bo", ...patch });
  const page = (items: TranscriptMessage[]) => displayMessages(items.map((m) => channelMessage(m, VIEWER, "c1")));
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
