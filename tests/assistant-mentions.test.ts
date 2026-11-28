import test from "node:test";
import assert from "node:assert/strict";
import { MentionTrigger, type GuildMessageMention, type MentionTriggerDeps } from "../src/clients/discord/assistant-mentions.js";
import type { AssistantStore } from "../src/assistant/store.js";
import { DEFAULT_ASSISTANT_LIMITS, type AssistantSettings, type Trigger } from "../src/assistant/types.js";

const HISTORY = [{ author: "u3", text: "earlier" }];

/** In-memory store. Only settings and triggers are used by the mention trigger. */
function fakeStore(enabledUsers: string[]) {
  const triggers: Trigger[] = [];
  const store: AssistantStore = {
    async settings(user) {
      if (!enabledUsers.includes(user)) return undefined;
      return { user, enabled: true, briefCron: null, timezone: "UTC", dmUpdates: false, quietStart: null, quietEnd: null, updated: 0 } satisfies AssistantSettings;
    },
    async addTrigger(trigger) { triggers.push(trigger); },
    async putSettings() { throw new Error("unused"); },
    async tasks() { throw new Error("unused"); },
    async task() { throw new Error("unused"); },
    async putTask() { throw new Error("unused"); },
    async dueTasks() { throw new Error("unused"); },
    async dueBriefs() { throw new Error("unused"); },
    async setBriefNextAt() { throw new Error("unused"); },
    async takeTriggers() { throw new Error("unused"); },
    async addApproval() { throw new Error("unused"); },
    async approval() { throw new Error("unused"); },
    async decideApproval() { throw new Error("unused"); },
    async setApprovalResult() { throw new Error("unused"); },
    async pendingApprovals() { throw new Error("unused"); },
    async addActivity() { throw new Error("unused"); },
    async activity() { throw new Error("unused"); },
    async markRead() { throw new Error("unused"); },
  };
  return { store, triggers };
}

function setup(options: { enabledUsers?: string[]; serverSetting?: string } = {}) {
  const { store, triggers } = fakeStore(options.enabledUsers ?? ["u2"]);
  let clock = 1_000_000;
  let next = 0;
  const deps: MentionTriggerDeps = {
    store,
    limits: async () => DEFAULT_ASSISTANT_LIMITS,
    serverSetting: async () => options.serverSetting,
    history: async () => HISTORY,
    now: () => clock,
    id: () => `trigger-${++next}`,
  };
  const trigger = new MentionTrigger(deps);
  const advance = (ms: number) => { clock += ms; };
  return { trigger, triggers, advance };
}

function guildMessage(overrides: Partial<GuildMessageMention> = {}): GuildMessageMention {
  return { server: "s1", channel: "c1", messageId: "m1", author: "u1", authorIsBot: false, text: "hey <@u2> look", mentionedUserIds: ["u2"], isDm: false, ...overrides };
}

test("mention adds trigger", async () => {
  const { trigger, triggers } = setup();
  await trigger.onGuildMessage(guildMessage());
  assert.equal(triggers.length, 1);
  const [added] = triggers;
  assert.ok(added);
  assert.equal(added.kind, "mention");
  assert.equal(added.owner, "u2");
  assert.equal(added.task, null);
  assert.deepEqual(added.payload, { server: "s1", channel: "c1", messageId: "m1", author: "u1", text: "hey <@u2> look", before: HISTORY });
});

test("debounce", async () => {
  const { trigger, triggers, advance } = setup();
  await trigger.onGuildMessage(guildMessage({ messageId: "m1" }));
  advance(60_000);
  await trigger.onGuildMessage(guildMessage({ messageId: "m2" }));
  assert.equal(triggers.length, 1, "a second mention inside the debounce adds nothing");
  advance(DEFAULT_ASSISTANT_LIMITS.mentionDebounceMinutes * 60_000);
  await trigger.onGuildMessage(guildMessage({ messageId: "m3" }));
  assert.equal(triggers.length, 2, "a mention after the debounce adds a trigger");
});

test("disabled user skipped", async () => {
  const { trigger, triggers } = setup({ enabledUsers: [] });
  await trigger.onGuildMessage(guildMessage());
  assert.equal(triggers.length, 0);
});

test("server opt-out skipped", async () => {
  const { trigger, triggers } = setup({ serverSetting: "false" });
  await trigger.onGuildMessage(guildMessage());
  assert.equal(triggers.length, 0);
});

test("bot author skipped", async () => {
  const { trigger, triggers } = setup();
  await trigger.onGuildMessage(guildMessage({ authorIsBot: true }));
  assert.equal(triggers.length, 0);
});

test("dm skipped", async () => {
  const { trigger, triggers } = setup();
  await trigger.onGuildMessage(guildMessage({ isDm: true }));
  assert.equal(triggers.length, 0);
});

test("self mention skipped", async () => {
  const { trigger, triggers } = setup({ enabledUsers: ["u1"] });
  await trigger.onGuildMessage(guildMessage({ author: "u1", mentionedUserIds: ["u1"] }));
  assert.equal(triggers.length, 0);
});
