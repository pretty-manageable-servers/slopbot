import test from "node:test";
import assert from "node:assert/strict";
import { MemberDirectory, UNKNOWN_USER } from "../src/member-directory.js";
import { DEFAULT_AVATAR, fakeSource } from "./member-fakes.js";

const SERVER = "1528063444874432734";
const ADA = "151441325952283850", GRACE = "151441325952283851", MIA = "151441325952283852", LEFT = "151441325952283853", GONE = "151441325952283854";
const SERVER_AVATAR = "https://cdn.discordapp.com/guilds/1/users/ada/avatar.png", USER_AVATAR = "https://cdn.discordapp.com/avatars/left/avatar.png";
const people = {
  [ADA]: { username: "ada", globalName: "Ada Lovelace", nickname: "Ada L", avatar: "https://cdn.discordapp.com/avatars/ada/a.png", serverAvatar: SERVER_AVATAR, inServer: true, email: "ada@example.com" },
  [GRACE]: { username: "grace", globalName: "Grace Hopper", inServer: true },
  [MIA]: { username: "mia", inServer: true, avatar: "https://cdn.discordapp.com/avatars/mia/m.png" },
  [LEFT]: { username: "left", avatar: USER_AVATAR },
};
const unknown = (id: string) => ({ id, displayName: UNKNOWN_USER, username: null, avatarUrl: null });

test("profiles use the server nickname, then the global name, then the username", async () => {
  const source = fakeSource(people);
  const found = await new MemberDirectory(source).profiles(SERVER, [ADA, GRACE, MIA]);
  assert.deepEqual(found.get(ADA), { id: ADA, displayName: "Ada L", username: "ada", avatarUrl: SERVER_AVATAR });
  assert.deepEqual(found.get(GRACE), { id: GRACE, displayName: "Grace Hopper", username: "grace", avatarUrl: DEFAULT_AVATAR });
  assert.deepEqual(found.get(MIA), { id: MIA, displayName: "mia", username: "mia", avatarUrl: people[MIA].avatar });
  assert.deepEqual(source.calls.members, [[ADA, GRACE, MIA]], 'one batch for the page');
  assert.deepEqual(source.calls.users, []);
});

test("users who left the server use the user lookup, and unknown users get the fallback", async () => {
  const source = fakeSource(people);
  const found = await new MemberDirectory(source).profiles(SERVER, [LEFT, GONE, "not-an-id"]);
  assert.deepEqual(found.get(LEFT), { id: LEFT, displayName: "left", username: "left", avatarUrl: USER_AVATAR });
  assert.deepEqual(found.get(GONE), unknown(GONE));
  assert.deepEqual(found.get("not-an-id"), unknown("not-an-id"));
  assert.deepEqual(source.calls.members, [[LEFT, GONE]], 'an ID that is not a snowflake is never sent to Discord');
  assert.deepEqual(source.calls.users, [LEFT, GONE]);
});

test("cache entries are kept per server", async () => {
  const source = fakeSource(people);
  const directory = new MemberDirectory(source);
  await directory.profiles(SERVER, [ADA]);
  await directory.profiles("1528063444874432999", [ADA]);
  assert.deepEqual(source.calls.members, [[ADA], [ADA]]);
});

test("no profile or search result carries an email", async () => {
  const source = fakeSource(people);
  const directory = new MemberDirectory(source);
  const text = JSON.stringify([...(await directory.profiles(SERVER, [ADA, LEFT, GONE])).values(), await directory.search(SERVER, "a")]);
  assert.doesNotMatch(text, /@example\.com|"email"/);
});
