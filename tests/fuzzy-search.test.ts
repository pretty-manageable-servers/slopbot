import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { FUZZY_SCAN, fuzzyScore } from "../src/search/fuzzy.js";

test("fuzzyScore matches typos, partial words, any word order and accents, and rejects unrelated text and short typos", () => {
  const matches: [string, string][] = [
    ["deploy hotfix", "hotfix went out, then deploy tonight"],
    ["hotfx dploy", "We should deploy the hotfix"],
    ["deplo", "Deployment notes for Ada"],
    ["cafe", "Café opening at noon"],
    ["CAFÉ", "the cafe is open"],
    ["gen", "#general"],
  ];
  // Words of up to 3 letters must match exactly, so "ax" does not match "ay".
  const misses: [string, string][] = [["deploy", "lunch was great"], ["zebra", "third question"], ["ax", "ay"], ["   ", "anything"], ["!!", "anything"]];
  for (const [query, text] of matches) assert.ok(fuzzyScore(query, text) > 0, `${query} should match ${text}`);
  for (const [query, text] of misses) assert.equal(fuzzyScore(query, text), 0, `${query} should not match ${text}`);
});

test("SQLite searchFuzzy scores recent messages and LIKE candidates, inside one channel only", async () => {
  const store = new SQLiteStore(":memory:");
  try {
    const base = { server: "s", channel: "c", author: "u", authorName: "Ada", addressed: false };
    // An old message, older than the scan window, is still found by its exact word.
    await store.ingest({ ...base, id: "old", text: "lighthouse plans", timestamp: 1 });
    await store.ingest({ ...base, id: "other", text: "lighthouse plans", timestamp: 2, channel: "d" });
    for (let index = 0; index < FUZZY_SCAN + 5; index++) await store.ingest({ ...base, id: `n${index}`, text: `chatter ${index}`, timestamp: 100 + index });
    // A typo inside the scan window (newest FUZZY_SCAN messages of the channel) is found without a LIKE hit.
    await store.ingest({ ...base, id: "typo", text: "Ligthouse lunch", timestamp: 150 });

    const hits = await store.searchFuzzy({ server: "s", channel: "c", query: "lighthouse", limit: 10 });
    assert.deepEqual(hits.map(hit => hit.message.id).sort(), ["old", "typo"]);
    assert.ok(hits.every(hit => hit.message.channel === "c" && hit.score > 0));
    assert.equal(hits.find(hit => hit.message.id === "old")!.message.authorName, "Ada");

    // Every chatter message matches; the limit keeps the newest ones first.
    const chatter = await store.searchFuzzy({ server: "s", channel: "c", query: "chatter", limit: 10 });
    assert.equal(chatter.length, 10);
    assert.equal(chatter[0]!.message.id, `n${FUZZY_SCAN + 4}`);
  } finally {
    store.close();
  }
});
