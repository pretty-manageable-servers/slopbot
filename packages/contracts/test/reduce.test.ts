import assert from "node:assert/strict";
import { test } from "node:test";
import { reduceTurn, type EngineEvent, type TurnView } from "@slopbot/contracts";

const turn = "m1";
const run = "r1";

function reduceAll(events: EngineEvent[]): TurnView | undefined {
  return events.reduce<TurnView | undefined>((view, event) => reduceTurn(view, event), undefined);
}

test("text deltas join into one part", () => {
  const view = reduceAll([
    { type: "turn.start", turn },
    { type: "text.delta", turn, run, text: "Hel" },
    { type: "text.delta", turn, run, text: "lo" },
  ]);
  assert.deepEqual(view?.parts, [{ kind: "text", text: "Hello" }]);
});

test("thinking then text makes two parts", () => {
  const view = reduceAll([
    { type: "thinking.delta", turn, run, text: "hmm" },
    { type: "text.delta", turn, run, text: "answer" },
  ]);
  assert.deepEqual(view?.parts, [
    { kind: "thinking", text: "hmm" },
    { kind: "text", text: "answer" },
  ]);
});

test("tool.input then tool.status with the same call make one part", () => {
  const view = reduceAll([
    { type: "tool.input", turn, run, call: "c1", name: "search", text: '{"q":' },
    { type: "tool.input", turn, run, call: "c1", name: "search", text: '"x"}' },
    { type: "tool.status", turn, call: "c1", name: "search", status: "completed", input: { q: "x" }, result: "3 hits" },
  ]);
  assert.deepEqual(view?.parts, [
    { kind: "tool", call: "c1", name: "search", status: "completed", inputText: '{"q":"x"}', input: { q: "x" }, result: "3 hits" },
  ]);
});

test("two calls with the same name stay apart", () => {
  const view = reduceAll([
    { type: "tool.status", turn, call: "c1", name: "search", status: "running" },
    { type: "tool.status", turn, call: "c2", name: "search", status: "running" },
    { type: "tool.status", turn, call: "c1", name: "search", status: "completed" },
  ]);
  assert.deepEqual(
    view?.parts.map(part => (part.kind === "tool" ? [part.call, part.status] : part.kind)),
    [["c1", "completed"], ["c2", "running"]],
  );
});

test("turn.end failed sets the status", () => {
  const view = reduceAll([
    { type: "turn.start", turn },
    { type: "turn.end", turn, status: "failed" },
  ]);
  assert.equal(view?.status, "failed");
});

test("reducing does not change the view it was given", () => {
  const before = reduceTurn(undefined, { type: "text.delta", turn, run, text: "a" });
  const after = reduceTurn(before, { type: "text.delta", turn, run, text: "b" });
  assert.deepEqual(before.parts, [{ kind: "text", text: "a" }]);
  assert.deepEqual(after.parts, [{ kind: "text", text: "ab" }]);
});

test("with event times, a thinking part gets its time when the next part starts or the turn ends", () => {
  const timed: [EngineEvent, number][] = [
    [{ type: "turn.start", turn }, 0],
    [{ type: "thinking.delta", turn, run, text: "Let me " }, 1_000],
    [{ type: "thinking.delta", turn, run, text: "look." }, 3_000],
    [{ type: "text.delta", turn, run, text: "Hi" }, 13_000],
    [{ type: "thinking.delta", turn, run, text: "More." }, 14_000],
    [{ type: "turn.end", turn, status: "done" }, 16_500],
  ];
  const view = timed.reduce<TurnView | undefined>((v, [event, at]) => reduceTurn(v, event, at), undefined)!;
  assert.deepEqual(view.parts, [
    { kind: "thinking", text: "Let me look.", startedAt: 1_000, durationMs: 12_000 },
    { kind: "text", text: "Hi" },
    { kind: "thinking", text: "More.", startedAt: 14_000, durationMs: 2_500 },
  ]);
  // Without times, as before: no start and no duration.
  assert.deepEqual(reduceAll(timed.map(([event]) => event))!.parts[0], { kind: "thinking", text: "Let me look." });
});
