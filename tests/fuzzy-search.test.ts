import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { FUZZY_SCAN, fuzzyScore, rankFuzzy } from "../src/search/fuzzy.js";

test("fuzzyScore matches typos, partial words, any word order and accents", () => {
  assert.ok(fuzzyScore("deploy hotfix", "hotfix went out, then deploy tonight") > 0.9);
  assert.ok(fuzzyScore("hotfx dploy", "We should deploy the hotfix") > 0.5);
  assert.ok(fuzzyScore("deplo", "Deployment notes for Ada") > 0);
  assert.ok(fuzzyScore("cafe", "Café opening at noon") > 0);
  assert.ok(fuzzyScore("CAFÉ", "the cafe is open") > 0);
  assert.ok(fuzzyScore("gen", "#general") > 0);
});

test("fuzzyScore gives no match to unrelated text and to short typos", () => {
  assert.equal(fuzzyScore("deploy", "lunch was great"), 0);
  assert.equal(fuzzyScore("zebra", "third question"), 0);
  // Words of up to 3 letters must match exactly, so "ax" does not match "ay".
  assert.equal(fuzzyScore("ax", "ay"), 0);
  assert.equal(fuzzyScore("   ", "anything"), 0);
  assert.equal(fuzzyScore("!!", "anything"), 0);
});

test("fuzzyScore ranks exact and phrase matches above typo matches", () => {
  const exact = fuzzyScore("lighthouse talk", "lighthouse talk tonight");
  const typo = fuzzyScore("lightouse talk", "lighthouse talk tonight");
  assert.ok(exact > typo, `${exact} should beat ${typo}`);
});

test("rankFuzzy keeps only matches and breaks ties with the newest message", () => {
  const message = (id: string, text: string, timestamp: number) => ({ id, server: "s", channel: "c", author: "u", authorName: "u", text, timestamp });
  const ranked = rankFuzzy("deploy", [
    message("old", "deploy notes", 1),
    message("new", "deploy notes", 2),
    message("typo", "deplyo notes", 3),
    message("none", "lunch", 4),
  ], 10);
  assert.deepEqual(ranked.map(hit => hit.message.id), ["new", "old", "typo"]);
  assert.equal(rankFuzzy("deploy", [message("a", "deploy", 1)], 0).length, 0);
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
