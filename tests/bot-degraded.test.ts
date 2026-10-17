import assert from "node:assert/strict";
import { test } from "node:test";
import { Application } from "../src/application.js";
import { Bot, type ChatGateway, type Incoming } from "../src/bot.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { DEGRADED_NOTE, type LlmMode, type LlmRouter } from "../src/llm-mode.js";
import { ParticipationGate } from "../src/participation.js";
import type { TaskWorker } from "../src/queue.js";
import type { UsageMeter } from "../src/usage-meter.js";

const incoming = (id: string, text: string, extra: Partial<Incoming> = {}): Incoming => ({
  id, server: "s", channel: "c", author: "alice", text,
  botAuthor: false, mentionsBot: false, repliesToBot: false, ...extra,
});

const nobody: LlmRouter = { select: () => undefined };

function setup(options: { mode?: LlmMode; router?: "absent" | "model" | "none"; worker?: TaskWorker; participation?: ParticipationGate } = {}) {
  const store = new SQLiteStore();
  const llm = new FakeLLM();
  let charged = 0;
  const usage = { async record() { charged++; }, async overGrace() { return false; } } as unknown as UsageMeter;
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] }, undefined, { usage });
  const outputs: string[] = [];
  const reactions: string[] = [];
  const gateway: ChatGateway = {
    async reply(_message, text) { outputs.push(text); return [{ id: `out:${outputs.length}`, server: "s", channel: "c", author: "bot", text }]; },
    async react(_message, emoji) { reactions.push(emoji); },
    async createTaskThread() { throw new Error("No thread expected"); },
    typing() { return () => undefined; },
  };
  const mode = options.mode ?? "normal";
  const router: LlmRouter | undefined = options.router === "model" ? { select: () => llm } : options.router === "none" ? nobody : undefined;
  const botOptions: ConstructorParameters<typeof Bot>[6] = {
    degraded: { mode: () => mode, statusNoteMinutes: () => 30 },
    ...(router ? { router } : {}),
    ...(options.worker ? { worker: options.worker } : {}),
    ...(options.participation ? { participation: options.participation } : {}),
  };
  const bot = new Bot(app, store, store, gateway, "s", ["c"], botOptions);
  return { store, llm, bot, outputs, reactions, charged: () => charged };
}

test("no model call when offline: one note, then a reaction, and nothing is queued", async t => {
  let queued = 0;
  const worker = { enqueue: async () => { queued++; } } as unknown as TaskWorker;
  const f = setup({ mode: "offline", router: "none", worker }); t.after(() => f.store.close());
  await f.bot.receive(incoming("1", "hello", { mentionsBot: true }));
  await f.bot.receive(incoming("2", "again", { mentionsBot: true }));
  assert.deepEqual(f.outputs, [DEGRADED_NOTE]);
  assert.deepEqual(f.reactions, ["⏸️"]);
  assert.equal(f.llm.prompts.length, 0);
  assert.equal(queued, 0);
  assert.equal(f.charged(), 0);
});

test("non-mention ignored", async t => {
  let decisions = 0;
  const participation = new ParticipationGate({ classify: async () => {
    decisions++; return { respond: true, addressed: true, reason: "continue" };
  } }, { enabled: true, contextMessages: 10, cooldownMs: 0, maxUnsolicitedPerHour: 10 });
  const f = setup({ mode: "offline", router: "none", participation }); t.after(() => f.store.close());
  await f.bot.receive(incoming("1", "ordinary chat"));
  assert.equal(decisions, 0);
  assert.deepEqual(f.outputs, []);
  assert.deepEqual(f.reactions, []);
  assert.equal(f.llm.prompts.length, 0);
});
