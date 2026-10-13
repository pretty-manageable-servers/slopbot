import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { DEFAULT_INSTRUCTIONS } from "../src/agent-runner.js";

test("the runner uses the team system prompt for every server, else the default", async t => {
  const llm = new FakeLLM(); const store = new SQLiteStore(); t.after(() => store.close());
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }, { server: "t", channel: "c" }] });
  const message = (id: string, server = "s") => ({ id, server, channel: "c", author: "a", text: "hello" });
  const system = () => String(llm.prompts.at(-1)!.prefix[0]!.content);
  await app.handle(message("1"));
  assert.ok(system().startsWith(DEFAULT_INSTRUCTIONS), "no saved prompt: the default");
  store.setSetting("global", "system_prompt", "Team rule: answer in French.");
  await app.handle(message("2"));
  assert.ok(system().startsWith("Team rule: answer in French."), "the saved prompt replaces the default");
  assert.ok(!system().includes(DEFAULT_INSTRUCTIONS));
  await app.handle(message("3", "t"));
  assert.ok(system().startsWith("Team rule: answer in French."), "the saved prompt is global");
  store.setSetting("global", "system_prompt", null);
  await app.handle(message("4"));
  assert.ok(system().startsWith(DEFAULT_INSTRUCTIONS), "a cleared prompt: the default again");
});
