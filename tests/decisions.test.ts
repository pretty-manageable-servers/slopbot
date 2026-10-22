import assert from "node:assert/strict";
import { test } from "node:test";
import { DecisionClassifier } from "../src/adapters/decisions.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";

const message = { id: "1", server: "s", channel: "c", author: "alice", text: "Slopbot help" };
const config = { baseUrl: "https://api.pmservers.org/ai/v1", apiKey: "test-only", model: "vane" };

test("unsolicited responses require high confidence and malformed results fail", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const classifier = new DecisionClassifier(config, store, async () => Response.json({ answers: { addressed: { probabilities: { yes: 0.1 } }, respond: { probabilities: { yes: 0.7 } } } }));
  assert.equal((await classifier.classify(message, [])).respond, false);
  const malformed = new DecisionClassifier(config, store, async () => Response.json({ answers: { addressed: { probabilities: { yes: "true" } }, respond: { probabilities: { yes: 1 } } } }));
  await assert.rejects(malformed.classify(message, []), /probability/);
});
