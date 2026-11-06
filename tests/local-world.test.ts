import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WORLD_PATH, loadLocalWorld, parseLocalWorld } from "../src/local/world.js";

const world = () => ({
  bot: { id: "300000000000000001", name: "Bot" },
  servers: [{ id: "100000000000000001", name: "Lab", icon: null }],
  users: [
    { id: "200000000000000001", name: "Owner", avatarUrl: null, servers: ["100000000000000001"], manage: ["100000000000000001"], team: "owner" },
    { id: "200000000000000002", name: "Member", avatarUrl: null, servers: ["100000000000000001"], manage: [] },
  ],
});

test("parses the checked-in fixture", () => {
  const fixture = loadLocalWorld(DEFAULT_WORLD_PATH);
  assert.equal(fixture.servers.length, 2);
  assert.deepEqual(fixture.users.map(user => user.name), ["Dev Owner", "Dev Member", "Outsider"]);
  assert.equal(fixture.users[0]!.team, "owner");
  assert.equal(fixture.users[1]!.team, undefined);
  assert.deepEqual(fixture.users[2]!.servers, []);
});

test("a user ID that is not a Discord ID names the field", () => {
  const bad = world(); bad.users[1]!.id = "dev-member";
  assert.throws(() => parseLocalWorld(bad), { message: "local-world: users[1].id is not a Discord ID" });
});

test("a duplicate ID is refused", () => {
  const bad = world(); bad.users[1]!.id = "200000000000000001";
  assert.throws(() => parseLocalWorld(bad), /users\[1\]\.id is a duplicate id/);
  const clash = world(); clash.servers[0]!.id = "300000000000000001"; clash.users.forEach(user => { user.servers = []; user.manage = []; });
  assert.throws(() => parseLocalWorld(clash), /servers\[0\]\.id is a duplicate id/);
});

test("an unknown server is refused", () => {
  const bad = world(); bad.users[1]!.servers = ["100000000000000009"];
  assert.throws(() => parseLocalWorld(bad), /users\[1\]\.servers\[0\] is an unknown server/);
});

test("a manage server must be one of the user's servers", () => {
  const bad = world(); bad.users[1]!.manage = ["100000000000000001"]; bad.users[1]!.servers = [];
  assert.throws(() => parseLocalWorld(bad), /users\[1\]\.manage\[0\] is a manage server not in servers/);
});
