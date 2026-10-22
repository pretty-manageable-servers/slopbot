import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplicationCommandDataResolvable } from "discord.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { buildToolCommands, buildUsageCommand, commandTextSize, DISCORD_COMMAND_TEXT_LIMIT, setGuildCommands } from "../src/adapters/discord-commands.js";
import { ToolRegistry } from "../src/tools.js";

/** A registry of tools with long descriptions, long option descriptions and 25-choice enums. */
function bigRegistry(count: number): { registry: ToolRegistry; store: SQLiteStore } {
  const store = new SQLiteStore(":memory:");
  const registry = new ToolRegistry(store, async () => false);
  for (let i = 0; i < count; i++) {
    const choices = Array.from({ length: 25 }, (_, j) => `tool${i}_choice_${j}_with_a_long_name`);
    registry.register({
      name: `big_tool_${i}`,
      description: `Long description for tool ${i}. `.repeat(12),
      fields: {
        topic: { type: "string", description: `Topic option for tool ${i}. `.repeat(8), required: true, choices },
        note: { type: "string", description: "A note about the request. ".repeat(10) },
        count: { type: "integer", description: "How many items to return. ".repeat(6), min: 1, max: 50 },
      },
      access: "member",
      effect: "read",
      retrySafe: true,
      async execute() { return "done"; },
    });
  }
  return { registry, store };
}

function optionNames(json: unknown): string[] {
  const options = (json as { options?: { name: string }[] }).options;
  return options?.map(option => option.name) ?? [];
}

test("tool_command_stays_under_discord_limit", t => {
  const { registry, store } = bigRegistry(40);
  t.after(() => store.close());
  const json = buildToolCommands(registry).toJSON();
  assert.ok(commandTextSize(json) < DISCORD_COMMAND_TEXT_LIMIT, `size ${commandTextSize(json)} must be under ${DISCORD_COMMAND_TEXT_LIMIT}`);
  // The budget still lets some tools through, so the command is not just the run subcommand.
  assert.ok(optionNames(json).length > 1);
  assert.ok(optionNames(json).length <= 25);
});

test("run_subcommand_always_present", t => {
  const { registry, store } = bigRegistry(40);
  const empty = new SQLiteStore(":memory:");
  const emptyRegistry = new ToolRegistry(empty, async () => false);
  t.after(() => { store.close(); empty.close(); });
  assert.ok(optionNames(buildToolCommands(registry).toJSON()).includes("run"));
  assert.ok(optionNames(buildToolCommands(emptyRegistry).toJSON()).includes("run"));
  assert.deepEqual(optionNames(buildToolCommands(registry, { runOnly: true }).toJSON()), ["run"]);
});

test("registration_retries_with_small_command_on_50035", async t => {
  const { registry, store } = bigRegistry(3);
  t.after(() => store.close());
  const calls: ApplicationCommandDataResolvable[][] = [];
  const logs: string[] = [];
  const guild = {
    commands: {
      async set(commands: ApplicationCommandDataResolvable[]) {
        calls.push(commands);
        if (calls.length === 1) throw Object.assign(new Error("Command exceeds maximum size (8000)"), { code: 50035 });
        return commands;
      },
    },
  };
  await setGuildCommands(guild, runOnly => [buildToolCommands(registry, { runOnly }).toJSON(), buildUsageCommand().toJSON()], message => logs.push(message));
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.length, 2, "every other command is still registered");
  const [slopbot, usage] = calls[1] as unknown as { name: string; options?: { name: string }[] }[];
  assert.equal(slopbot!.name, "slopbot");
  assert.deepEqual(optionNames(slopbot!), ["run"]);
  assert.equal(usage!.name, "usage");
  assert.equal(logs.length, 1);
});

test("registration_rethrows_other_errors_without_retry", async () => {
  const calls: unknown[] = [];
  const guild = { commands: { async set(commands: ApplicationCommandDataResolvable[]) { calls.push(commands); throw Object.assign(new Error("Missing Access"), { code: 50001 }); } } };
  await assert.rejects(setGuildCommands(guild, () => [], () => {}), { code: 50001 });
  assert.equal(calls.length, 1);
});
