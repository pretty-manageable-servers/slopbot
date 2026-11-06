import { describe, expect, test } from "vitest";
import type { TranscriptMessage } from "../api-types";
import { emptyChat, chatMessages, type RunStep } from "../events";
import { applyTranscriptEvent, channelMessage, displayMessages, metaOf, type TranscriptEvent } from "./transcript";

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
