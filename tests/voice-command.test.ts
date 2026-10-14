import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVoiceCommand } from "../src/adapters/discord.js";

test("voice is its own top-level command with join, reply and instructions", () => {
  const json = buildVoiceCommand().toJSON();
  assert.equal(json.name, "voice");
  const options = Object.fromEntries((json.options ?? []).map(option => [option.name, option as { required?: boolean; choices?: { value: string }[] }]));
  assert.equal(options.action?.required, true);
  assert.deepEqual(options.action?.choices?.map(choice => choice.value), ["join", "leave", "status", "style", "propose"]);
  assert.deepEqual(options.reply?.choices?.map(choice => choice.value), ["voice", "text"]);
  assert.ok(options.instructions);
});
