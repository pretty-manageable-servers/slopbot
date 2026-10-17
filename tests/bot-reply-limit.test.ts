import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BOT_REPLY_LIMIT, botReplyLimit, botReplyLimits } from "../src/bot-reply-limit.js";

test("a temporary bot reply limit is used until it ends, then the normal limit comes back", () => {
  const saved = { replies: 3, minutes: 10, temporary: { replies: 100, minutes: 5, until: 2_000 } };
  assert.deepEqual(botReplyLimit(saved, 1_000), { replies: 100, minutes: 5 });
  assert.deepEqual(botReplyLimit(saved, 2_000), { replies: 3, minutes: 10 });
  assert.equal(botReplyLimits(saved, 3_000).temporary, undefined);
});

test("bad saved limits fall back to the default", () => {
  assert.deepEqual(botReplyLimit({ replies: -1, minutes: 10 }), DEFAULT_BOT_REPLY_LIMIT);
  assert.deepEqual(botReplyLimit({ replies: 3, minutes: 10, temporary: { replies: 5, minutes: 0, until: Date.now() + 60_000 } }), { replies: 3, minutes: 10 });
});
