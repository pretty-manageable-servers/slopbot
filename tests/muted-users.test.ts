import assert from "node:assert/strict";
import { test } from "node:test";
import { mutedUsers, userId } from "../src/muted-users.js";

test("muted users drop ended mutes and bad rows", () => {
  const user = "123456789012345678";
  assert.deepEqual(mutedUsers({ [user]: 2000, "987654321098765432": 500, bad: 9999 }, 1000), { [user]: 2000 });
  assert.deepEqual(mutedUsers(null), {});
});

test("user IDs come from IDs and mentions", () => {
  assert.equal(userId("<@123456789012345678>"), "123456789012345678");
  assert.equal(userId("<@!123456789012345678>"), "123456789012345678");
  assert.equal(userId(" 123456789012345678 "), "123456789012345678");
  assert.equal(userId("alice"), undefined);
});
