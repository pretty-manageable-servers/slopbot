import assert from "node:assert/strict";
import { test } from "node:test";
import { DecisionClassifier } from "../src/adapters/decisions.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ProviderError } from "../src/adapters/chat-completions.js";

const message = { id: "1", server: "s", channel: "c", author: "alice", text: "Slopbot help" };
const config = { baseUrl: "https://api.pmservers.org/ai/v1", apiKey: "test-only", model: "vane" };

test("Vane uses System One API and validates probability thresholds", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, `${config.baseUrl}/systemone`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model);
    assert.equal(body.questions.addressed.type, "choice");
    assert.equal(body.stream, undefined);
    return Response.json({ answers: { addressed: { probabilities: { yes: 0.8 } }, respond: { probabilities: { yes: 0.7 } } } });
  };
  const decision = await new DecisionClassifier(config, store, fetcher).classify(message, []);
  assert.equal(decision.respond, true); assert.equal(decision.addressed, true);
});

test("unsolicited responses require high confidence and malformed results fail", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const classifier = new DecisionClassifier(config, store, async () => Response.json({ answers: { addressed: { probabilities: { yes: 0.1 } }, respond: { probabilities: { yes: 0.7 } } } }));
  assert.equal((await classifier.classify(message, [])).respond, false);
  const malformed = new DecisionClassifier(config, store, async () => Response.json({ answers: { addressed: { probabilities: { yes: "true" } }, respond: { probabilities: { yes: 1 } } } }));
  await assert.rejects(malformed.classify(message, []), /probability/);
});

test("decision provider errors retain HTTP status without printing response bodies", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const classifier = new DecisionClassifier(config, store, async () => new Response("private body", { status: 401 }));
  await assert.rejects(classifier.classify(message, []), error => error instanceof ProviderError && error.status === 401);
});

test("unsupported decisions endpoint falls back and is not retried each message", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let requests = 0, fallbackCalls = 0;
  const classifier = new DecisionClassifier(config, store, async () => {
    requests++; return new Response(null, { status: 404 });
  }, { async classify() { fallbackCalls++; return { addressed: true, respond: true, reason: "fallback" }; } });
  assert.equal((await classifier.classify(message, [])).reason, "fallback");
  assert.equal((await classifier.classify(message, [])).respond, true);
  assert.equal(requests, 1); assert.equal(fallbackCalls, 2);
});

test("Vane receives alias instructions and independently selects funny reactions", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const classifier = new DecisionClassifier(config, store, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    for (const alias of ["slop", "bot", "sb", "ai", "machine"]) assert.ok(body.questions.addressed.instructions.includes(alias));
    assert.ok(body.questions.funny.instructions.includes("No addressing is required"));
    assert.equal(JSON.parse(body.state).CURRENT.id, message.id);
    return Response.json({ answers: { addressed: { probabilities: { yes: 0.1 } }, respond: { probabilities: { yes: 0.1 } }, funny: { probabilities: { yes: 0.95 } } } });
  });
  const result = await classifier.classify(message, []);
  assert.equal(result.respond, false);
  assert.equal(result.emoji, "😂");
});
