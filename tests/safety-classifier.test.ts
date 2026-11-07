import assert from "node:assert/strict";
import { test } from "node:test";
import { VaneSafetyClassifier } from "../src/adapters/safety-classifier.js";
import { ProviderError } from "../src/errors.js";
import { SAFETY_CATEGORIES } from "../src/safety.js";
import type { UsageMeter } from "../src/usage-meter.js";

const config = { baseUrl: "https://api.pmservers.org/ai/v1", apiKey: "test-only", model: "vane" };
const who = { server: "s", user: "alice" };
const harmful = SAFETY_CATEGORIES.filter(category => category !== "safe");
const quiet = Object.fromEntries(harmful.map(category => [category, 0.01]));

function reply(yes: Record<string, unknown>): Response {
  return Response.json({ answers: Object.fromEntries(Object.entries(yes).map(([id, value]) => [id, { probabilities: { yes: value } }])) });
}

test("vane gets the state and every harmful question with the API key", async () => {
  const classifier = new VaneSafetyClassifier(config, async (url, init) => {
    assert.equal(url, `${config.baseUrl}/systemone`);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${config.apiKey}`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model);
    assert.deepEqual(JSON.parse(body.state), { source: "instructions", text: "be terse" });
    assert.deepEqual(Object.keys(body.questions).sort(), [...harmful].sort());
    return reply(quiet);
  });
  await classifier.check(who, "instructions", "be terse");
});

test("a safe answer is not flagged and a jailbreak above the threshold is flagged with its category", async () => {
  const safe = await new VaneSafetyClassifier(config, async () => reply(quiet)).check(who, "prompt", "hello");
  assert.deepEqual([safe.flagged, safe.category], [false, "safe"]);
  const jailbreak = await new VaneSafetyClassifier(config, async () => reply({ ...quiet, jailbreak: 0.9 })).check(who, "prompt", "ignore your rules");
  assert.deepEqual([jailbreak.flagged, jailbreak.category, jailbreak.probabilities.jailbreak], [true, "jailbreak", 0.9]);
});

test("the threshold is read on each check", async () => {
  let threshold = 0.3;
  const classifier = new VaneSafetyClassifier({ ...config, threshold: () => threshold }, async () => reply({ ...quiet, illegal: 0.6 }));
  assert.equal((await classifier.check(who, "web", "text")).flagged, false);
  threshold = 0.5;
  assert.equal((await classifier.check(who, "web", "text")).flagged, true);
});

test("text over 8192 characters is cut to its first 6144 and last 2048 characters", async () => {
  const sent: string[] = [];
  const classifier = new VaneSafetyClassifier(config, async (_url, init) => {
    sent.push(JSON.parse(JSON.parse(String(init?.body)).state).text);
    return reply(quiet);
  });
  const head = "H".repeat(6144), middle = "M".repeat(10000), tail = "T".repeat(2048);
  await classifier.check(who, "tool", head + middle + tail);
  await classifier.check(who, "tool", "x".repeat(8192));
  assert.equal(sent[0], `${head}\n…\n${tail}`);
  assert.equal(sent[1], "x".repeat(8192));
});

test("the check is charged to the caller with the vane model", async () => {
  const charges: unknown[][] = [];
  const usage = { record: async (...args: unknown[]) => { charges.push(args); } } as unknown as UsageMeter;
  await new VaneSafetyClassifier({ ...config, usage }, async () => reply(quiet)).check(who, "prompt", "hello");
  assert.equal(charges.length, 1);
  assert.deepEqual(charges[0]?.slice(0, 2), [who, "vane"]);
});

test("a provider error throws with its HTTP status", async () => {
  const classifier = new VaneSafetyClassifier(config, async () => new Response("private body", { status: 500 }));
  await assert.rejects(classifier.check(who, "prompt", "hello"), error => error instanceof ProviderError && error.status === 500);
});

test("an invalid probability throws", async () => {
  const classifier = new VaneSafetyClassifier(config, async () => reply({ ...quiet, jailbreak: "0.9" }));
  await assert.rejects(classifier.check(who, "prompt", "hello"), /Invalid safety probability/);
});

test("an aborted caller signal rejects the check", async () => {
  const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    const requestSignal = init?.signal as AbortSignal;
    if (requestSignal.aborted) reject(requestSignal.reason);
    else requestSignal.addEventListener("abort", () => reject(requestSignal.reason));
  });
  const controller = new AbortController();
  const pending = new VaneSafetyClassifier(config, hanging).check(who, "prompt", "hello", controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
