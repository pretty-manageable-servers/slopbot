import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelAccess } from "../src/channel-access.js";
import { LocalDirectory, localChannelAccessSource, localMemberSource, localTeamSource } from "../src/local/local-sources.js";
import { parseLocalWorld } from "../src/local/world.js";
import { MemberDirectory } from "../src/member-directory.js";

const SERVER = "100000000000000001";
const OTHER_SERVER = "100000000000000002";
const OWNER = "200000000000000001";
const MEMBER = "200000000000000002";
const DEV = "200000000000000003";
const OUTSIDER = "200000000000000004";
const UNKNOWN = "200000000000000009";
const CHANNEL = "400000000000000001";
const PRIVATE = "web:4f2c9a";

const world = () => parseLocalWorld({
  bot: { id: "300000000000000001", name: "Slopbot (local)" },
  servers: [{ id: SERVER, name: "Lab", icon: null }, { id: OTHER_SERVER, name: "Second Lab", icon: null }],
  users: [
    { id: OWNER, name: "Owner", avatarUrl: null, servers: [SERVER, OTHER_SERVER], manage: [SERVER, OTHER_SERVER], team: "owner" },
    { id: MEMBER, name: "Member", avatarUrl: null, servers: [SERVER], manage: [] },
    { id: "200000000000000005", name: "Mara", avatarUrl: null, servers: [SERVER], manage: [] },
    { id: DEV, name: "Dev", avatarUrl: null, servers: [SERVER], manage: [], team: "developer" },
    { id: OUTSIDER, name: "Outsider", avatarUrl: null, servers: [], manage: [] },
  ],
});

test("a member of the server is returned with the fixture's Discord facts", async () => {
  const found = await localMemberSource(world()).members(SERVER, [MEMBER, OUTSIDER, UNKNOWN]);
  assert.deepEqual([...found.keys()], [MEMBER]);
  assert.deepEqual(found.get(MEMBER), {
    user: { id: MEMBER, username: "Member", globalName: "Member", avatarUrl: null, defaultAvatarUrl: "/console/favicon.svg" },
    nickname: null,
    avatarUrl: null,
  });
});

test("a user is found by ID, and an unknown ID throws", async () => {
  const source = localMemberSource(world());
  assert.equal((await source.user(OUTSIDER)).username, "Outsider");
  await assert.rejects(source.user(UNKNOWN), { message: "Unknown local user" });
});

test("search matches the start of the name, ignoring case, up to the limit", async () => {
  const source = localMemberSource(world());
  const names = async (query: string, limit: number) => (await source.search(SERVER, query, limit)).map(record => record.user.username);
  assert.deepEqual(await names("M", 10), ["Member", "Mara"]);
  assert.deepEqual(await names("MA", 10), ["Mara"]);
  assert.deepEqual(await names("M", 1), ["Member"]);
  assert.deepEqual(await names("ara", 10), []);
  assert.deepEqual(await names("out", 10), [], "a user outside the server is not searched");
});

test("isMember is true for a server member, false for an outsider and an unknown user", async () => {
  const directory = new LocalDirectory(world(), new MemberDirectory(localMemberSource(world())));
  assert.equal(await directory.isMember(MEMBER, SERVER), true);
  assert.equal(await directory.isMember(OUTSIDER, SERVER), false);
  assert.equal(await directory.isMember(UNKNOWN, SERVER), false);
});

test("canManage is true only for a user with Manage Server", async () => {
  const directory = new LocalDirectory(world(), new MemberDirectory(localMemberSource(world())));
  assert.equal(await directory.canManage(OWNER, SERVER), true);
  assert.equal(await directory.canManage(MEMBER, SERVER), false);
  assert.equal(await directory.canManage(UNKNOWN, SERVER), false);
});

test("profiles resolve through the member directory, with the fixture name and the default avatar", async () => {
  const directory = new LocalDirectory(world(), new MemberDirectory(localMemberSource(world())));
  const profiles = await directory.profiles(SERVER, [MEMBER]);
  assert.deepEqual(profiles.get(MEMBER), { id: MEMBER, displayName: "Member", username: "Member", avatarUrl: "/console/favicon.svg" });
});

test("the team owner is the user with team owner, and the others with a team are members", async () => {
  const team = await localTeamSource(world()).load();
  assert.equal(team.ownerId, OWNER);
  assert.deepEqual(team.members, [{ id: DEV, role: "developer", accepted: true }]);
});

test("a private chat channel gives no channel access in local mode", async () => {
  const access = new ChannelAccess(localChannelAccessSource(world()));
  assert.deepEqual(await access.check(SERVER, PRIVATE, MEMBER), { view: false, send: false });
});

test("a normal channel gives no channel access in local mode", async () => {
  const access = new ChannelAccess(localChannelAccessSource(world()));
  assert.deepEqual(await access.check(SERVER, CHANNEL, MEMBER), { view: false, send: false });
});
