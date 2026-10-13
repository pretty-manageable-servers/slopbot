import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { buildToolCommands, buildUsageCommand, usageBar, usageEmbed, usageReply } from "../src/adapters/discord-commands.js";
import { ToolRegistry } from "../src/tools.js";
import { UserLimiter, usageView } from "../src/user-limiter.js";

const limiter = (store: SQLiteStore, fiveHour: number, week: number) => new UserLimiter(store, { fiveHourCostMicros: fiveHour, weekCostMicros: week, gracePercent: 10 });

test("the /usage embed shows percents, a 10-block bar and banked resets, never dollars", async () => {
  const store = new SQLiteStore(":memory:"), limits = limiter(store, 1000000, 3000000);
  await limits.record("s", "alice", 300000);
  await store.grantResets("s", "alice", "week", 2);
  const embed = usageEmbed(usageView(await limits.usage("s", "alice")));
  assert.equal(embed.title, "Your Slopbot usage");
  assert.equal(embed.description, "Plan: Seed (free)");
  const [fiveHour, weekly] = embed.fields ?? [];
  assert.equal(fiveHour?.name, "5-hour");
  assert.equal(weekly?.name, "weekly");
  assert.match(fiveHour!.value, /^▰▰▰▱▱▱▱▱▱▱\n30% used\nresets <t:\d+:R>\nBanked resets: 0$/);
  assert.match(weekly!.value, /^▰▱▱▱▱▱▱▱▱▱\n10% used\nresets <t:\d+:R>\nBanked resets: 2$/);
  assert.doesNotMatch(JSON.stringify(embed), /\$|cost|spent/i);
  store.close();
});

test("a window with no limit shows No limit and no reset time until it runs", async () => {
  const store = new SQLiteStore(":memory:"), limits = limiter(store, 1000000, 0);
  const embed = usageEmbed(usageView(await limits.usage("s", "alice")));
  assert.equal(embed.fields?.[1]?.value, "▱▱▱▱▱▱▱▱▱▱ No limit\nBanked resets: 0");
  assert.equal(embed.fields?.[0]?.value, "▱▱▱▱▱▱▱▱▱▱\n0% used\nBanked resets: 0");
  store.close();
});

test("usageBar draws 10 blocks for any percent", () => {
  assert.equal(usageBar(34), "▰▰▰▱▱▱▱▱▱▱");
  assert.equal(usageBar(0), "▱▱▱▱▱▱▱▱▱▱");
  assert.equal(usageBar(100), "▰▰▰▰▰▰▰▰▰▰");
  assert.equal(usageBar(null), "▱▱▱▱▱▱▱▱▱▱");
});

test("a user over the limit can still run /usage and use a banked reset, and /usage charges nothing", async () => {
  const store = new SQLiteStore(":memory:"), limits = limiter(store, 100, 0);
  await limits.record("s", "alice", 100);
  await store.grantResets("s", "alice", "5h", 1);
  assert.equal((await limits.check("s", "alice")).allowed, false);
  const shown = await usageReply(limits, "s", "alice", null);
  assert.equal(shown.content, undefined);
  assert.match(JSON.stringify(shown.embeds), /100% used/);
  assert.equal((await limits.usage("s", "alice"))[0]!.spent, 100);
  assert.equal((await limits.check("s", "alice")).allowed, false);
  const reset = await usageReply(limits, "s", "alice", "5h");
  assert.equal(reset.content, "Used one 5-hour reset. That window is cleared.");
  assert.equal((await limits.check("s", "alice")).allowed, true);
  store.close();
});

test("/usage reset uses one banked reset per window, then says none is left", async () => {
  const store = new SQLiteStore(":memory:"), limits = limiter(store, 100, 1000);
  await limits.record("s", "alice", 100);
  await store.grantResets("s", "alice", "5h", 1);
  assert.equal((await usageReply(limits, "s", "alice", "week")).content, "You have no banked weekly reset.");
  const first = await usageReply(limits, "s", "alice", "5h");
  assert.equal(first.content, "Used one 5-hour reset. That window is cleared.");
  assert.match(JSON.stringify(first.embeds), /0% used/);
  // The weekly window keeps its spend and is not cleared.
  assert.match(JSON.stringify(first.embeds), /10% used/);
  assert.equal((await limits.usage("s", "alice"))[1]!.spent, 100);
  const second = await usageReply(limits, "s", "alice", "5h");
  assert.equal(second.content, "You have no banked 5-hour reset.");
  assert.deepEqual(second.embeds, []);
  store.close();
});

test("/usage rejects an unknown window without touching any banked reset", async () => {
  const store = new SQLiteStore(":memory:"), limits = limiter(store, 100, 0);
  await store.grantResets("s", "alice", "5h", 1);
  assert.equal((await usageReply(limits, "s", "alice", "month")).content, "Choose 5-hour or weekly to reset.");
  assert.equal((await limits.usage("s", "alice"))[0]!.banked, 1);
  store.close();
});

test("the /usage command is top-level with one optional reset choice, and /slopbot is unchanged", () => {
  const usage = buildUsageCommand().toJSON() as unknown as { name: string; description: string; options: { name: string; required?: boolean; choices?: { value: string }[] }[] };
  assert.equal(usage.name, "usage");
  assert.equal(usage.description, "See your Slopbot usage and limits");
  assert.deepEqual(usage.options.map(option => [option.name, option.required]), [["reset", false]]);
  assert.deepEqual(usage.options[0]!.choices?.map(choice => choice.value), ["5h", "week"]);
  const registry = new ToolRegistry(new SQLiteStore(":memory:"), async () => false);
  assert.equal(buildToolCommands(registry).toJSON().name, "slopbot");
});
