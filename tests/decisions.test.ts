import assert from "node:assert/strict";
import { test } from "node:test";
import { DecisionClassifier } from "../src/adapters/decisions.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ProviderError } from "../src/adapters/chat-completions.js";

const message = { id: "1", server: "s", channel: "c", author: "alice", text: "Slopbot help" };
const config = { baseUrl: "https://api.pmservers.org/ai/v1", apiKey: "test-only", model: "typesafe/kev-4b" };

test("kev uses Decisions API and validates probability thresholds", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, `${config.baseUrl}/decisions`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model);
    assert.equal(body.questions.addressed.kind, "noul");
    assert.equal(body.stream, undefined);
    return Response.json({ answers: { addressed: { value: 0.8 }, respond: { value: 0.7 } } });
  };
  const decision = await new DecisionClassifier(config, store, fetcher).classify(message, []);
  assert.equal(decision.respond, true); assert.equal(decision.addressed, true);
});

test("unsolicited responses require high confidence and malformed results fail", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const classifier = new DecisionClassifier(config, store, async () => Response.json({ answers: { addressed: { value: 0.1 }, respond: { value: 0.7 } } }));
  assert.equal((await classifier.classify(message, [])).respond, false);
  const malformed = new DecisionClassifier(config, store, async () => Response.json({ answers: { addressed: { value: "true" }, respond: { value: 1 } } }));
  await assert.rejects(malformed.classify(message, []), /probability/);
});

test("decision provider errors retain HTTP status without printing response bodies", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const classifier = new DecisionClassifier(config, store, async () => new Response("private body", { status: 401 }));
  await assert.rejects(classifier.classify(message, []), error => error instanceof ProviderError && error.status === 401);
});
