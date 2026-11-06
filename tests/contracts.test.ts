import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineEnvelope, type Surface } from "@slopbot/contracts";
import { surfaceOf } from "../src/engine/api.js";
import { parseMessage, type Message } from "../src/domain.js";

const envelope = { seq: 1, at: 1, conversation: { server: "s", channel: "web:abc" } };

test("EngineEnvelope accepts a known event and rejects an unknown type", () => {
  assert.equal(EngineEnvelope.safeParse({ ...envelope, event: { type: "turn.start", turn: "m1" } }).success, true);
  assert.equal(EngineEnvelope.safeParse({ ...envelope, event: { type: "bogus" } }).success, false);
});

test("surfaceOf derives the surface from the channel, and an explicit surface wins", () => {
  const cases: [Pick<Message, "channel" | "surface">, Surface][] = [
    [{ channel: "web:abc" }, "web"],
    [{ channel: "web:dm:1" }, "discord-dm"],
    [{ channel: "123" }, "discord"],
    [{ channel: "123", surface: "web" }, "web"],
  ];
  for (const [message, surface] of cases) assert.equal(surfaceOf(message), surface);
});

test("parseMessage rejects an unknown surface and keeps a valid one", () => {
  const base = { id: "m1", server: "s", channel: "web:abc", author: "alice", text: "hi" };
  assert.throws(() => parseMessage({ ...base, surface: "x" }), TypeError);
  assert.equal(parseMessage({ ...base, surface: "discord-dm" }).surface, "discord-dm");
});
