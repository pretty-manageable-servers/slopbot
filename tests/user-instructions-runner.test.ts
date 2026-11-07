import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import type { UserInstructionsStore } from "../src/user-instructions.js";

class FakeInstructions implements UserInstructionsStore {
  constructor(private readonly saved: Record<string, string>, private readonly fails = false) {}
  async userInstructions(user: string) {
    if (this.fails) throw new Error("store unavailable");
    const text = this.saved[user];
    return text === undefined ? undefined : { text, updated: 1 };
  }
  async setUserInstructions(): Promise<void> { throw new Error("not used"); }
  async deleteUserInstructions(): Promise<void> { throw new Error("not used"); }
}

function setup(t: { after(fn: () => void): void }, saved: Record<string, string>, fails = false) {
  const llm = new FakeLLM(); const store = new SQLiteStore(); t.after(() => store.close());
  const policy = { allowedChannels: [{ server: "s", channel: "web:abc" }, { server: "s", channel: "web:dm:123" }, { server: "s", channel: "c" }] };
  const app = new Application(store, llm, policy, undefined, { instructions: new FakeInstructions(saved, fails) });
  const message = (id: string, channel: string, author: string, isBot = false) => ({ id, server: "s", channel, author, text: "hello", ...(isBot ? { isBot } : {}) });
  const lastPrefix = () => llm.prompts.at(-1)!.prefix;
  return { app, llm, message, lastPrefix };
}

test("a web chat run adds the saved instructions as a second system item and keeps the first item", async t => {
  const { app, message, lastPrefix } = setup(t, { alice: "Answer in short bullets." });
  await app.handle(message("1", "web:abc", "bob"));
  const baseline = lastPrefix();
  await app.handle(message("2", "web:abc", "alice"));
  const prefix = lastPrefix();
  assert.equal(prefix.length, 2);
  assert.equal(prefix[0]!.content, baseline[0]!.content, "the shared system item does not change");
  assert.equal(prefix[1]!.role, "system");
  assert.ok(prefix[1]!.content.includes("<user-instructions>\nAnswer in short bullets.\n</user-instructions>"));
});

test("a Discord DM run (web: prefix) also gets the saved instructions", async t => {
  const { app, message, lastPrefix } = setup(t, { alice: "Answer in French." });
  await app.handle(message("1", "web:dm:123", "alice"));
  assert.equal(lastPrefix().length, 2);
  assert.ok(lastPrefix()[1]!.content.includes("Answer in French."));
});

test("a server channel run does not get the saved instructions", async t => {
  const { app, message, lastPrefix } = setup(t, { alice: "Answer in French." });
  await app.handle(message("1", "c", "alice"));
  assert.equal(lastPrefix().length, 1);
});

test("another author's saved instructions are not used", async t => {
  const { app, message, lastPrefix } = setup(t, { alice: "Answer in French." });
  await app.handle(message("1", "web:abc", "bob"));
  assert.equal(lastPrefix().length, 1, "bob has no saved text");
  assert.ok(!lastPrefix()[0]!.content.includes("Answer in French."));
});

test("a bot message in a web chat does not get the saved instructions", async t => {
  const { app, message, lastPrefix } = setup(t, { alice: "Answer in French." });
  await app.handle(message("1", "web:abc", "alice", true));
  assert.equal(lastPrefix().length, 1);
});

test("a failing instructions store still gets an answer, without the instructions", async t => {
  t.mock.method(console, "warn", () => {});
  const { app, llm, message, lastPrefix } = setup(t, { alice: "Answer in French." }, true);
  const reply = await app.handle(message("1", "web:abc", "alice"));
  assert.ok(reply, "the run answers");
  assert.equal(llm.prompts.length, 1);
  assert.equal(lastPrefix().length, 1);
});
