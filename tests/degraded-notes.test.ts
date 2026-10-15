import assert from "node:assert/strict";
import { test } from "node:test";
import { DegradedNotes } from "../src/degraded-notes.js";

const minute = 60_000;

test("note once per window", () => {
  let windowMinutes = 30;
  const notes = new DegradedNotes(() => windowMinutes);
  assert.equal(notes.shouldPost("c", 0), true);
  assert.equal(notes.shouldPost("c", 29 * minute), false);
  assert.equal(notes.shouldPost("other", 29 * minute), true);
  assert.equal(notes.shouldPost("c", 30 * minute), true);
  assert.equal(notes.shouldPost("c", 31 * minute), false);
  // An admin change applies to the next check.
  windowMinutes = 5;
  assert.equal(notes.shouldPost("c", 36 * minute), true);
});
