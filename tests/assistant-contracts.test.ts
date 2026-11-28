import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { assistantHomeChannel, assistantTaskChannel, assistantTaskMemoryChannel, defaultRule, isAssistantChannel } from "../src/assistant/types.js";

test("assistant channel helpers", () => {
  assert.equal(isAssistantChannel(assistantHomeChannel("u1")), true);
  assert.equal(isAssistantChannel(assistantTaskChannel("t1")), true);
  assert.equal(isAssistantChannel("web:chat-1"), false);
  assert.equal(isAssistantChannel(assistantTaskMemoryChannel("t1")), false);
});

test("default rule allows reads and asks for writes", () => {
  assert.equal(defaultRule("read"), "allow");
  assert.equal(defaultRule("write"), "ask");
});

test("sqlite schema creates assistant tables", () => {
  const store = new SQLiteStore(":memory:");
  const db = (store as unknown as { db: DatabaseSync }).db;
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'assistant_%' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(names, ["assistant_activity", "assistant_approvals", "assistant_settings", "assistant_tasks", "assistant_triggers"]);
});
