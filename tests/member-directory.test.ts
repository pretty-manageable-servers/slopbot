import test from "node:test";
import assert from "node:assert/strict";
import { GatewayIntentBits, type Client } from "discord.js";
import { MemberDirectory, UNKNOWN_USER, discordMemberSource } from "../src/member-directory.js";
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

test("a failed member batch still resolves users one by one", async () => {
  const source = fakeSource(people);
  source.members = async () => { throw new Error('guild is gone'); };
  const found = await new MemberDirectory(source).profiles(SERVER, [LEFT, GONE]);
  assert.equal(found.get(LEFT)?.displayName, 'left');
  assert.deepEqual(found.get(GONE), unknown(GONE));
});

test("profiles are cached for 10 minutes and failed lookups for one minute", async () => {
  let clock = 1_000_000;
  const source = fakeSource(people);
  const directory = new MemberDirectory(source, () => clock);
  await directory.profiles(SERVER, [ADA, GONE]);
  await directory.profiles(SERVER, [ADA, GONE]);
  assert.deepEqual(source.calls.members, [[ADA, GONE]], 'the second call reads the cache');
  assert.deepEqual(source.calls.users, [GONE]);
  clock += 61_000;
  await directory.profiles(SERVER, [ADA, GONE]);
  assert.deepEqual(source.calls.members, [[ADA, GONE], [GONE]], 'only the failed user is looked up again');
  clock += 10 * 60_000;
  await directory.profiles(SERVER, [ADA]);
  assert.deepEqual(source.calls.members.at(-1), [ADA], 'a found user is looked up again after 10 minutes');
});

test("cache entries are kept per server", async () => {
  const source = fakeSource(people);
  const directory = new MemberDirectory(source);
  await directory.profiles(SERVER, [ADA]);
  await directory.profiles("1528063444874432999", [ADA]);
  assert.deepEqual(source.calls.members, [[ADA], [ADA]]);
});

test("search trims the query, clamps the limit and maps results like profiles", async () => {
  const source = fakeSource(people);
  const directory = new MemberDirectory(source);
  assert.deepEqual(await directory.search(SERVER, "   "), []);
  assert.deepEqual(source.calls.search, [], 'an empty query does not call Discord');
  const hits = await directory.search(SERVER, "  ada ", 100);
  assert.deepEqual(source.calls.search, [{ query: "ada", limit: 25 }]);
  assert.deepEqual(hits, [{ id: ADA, displayName: "Ada L", username: "ada", avatarUrl: SERVER_AVATAR }]);
  await directory.search(SERVER, "g", 0);
  await directory.search(SERVER, "g");
  assert.deepEqual(source.calls.search.slice(1), [{ query: "g", limit: 1 }, { query: "g", limit: 10 }]);
  assert.deepEqual(await directory.profiles(SERVER, [ADA]), new Map([[ADA, { id: ADA, displayName: "Ada L", username: "ada", avatarUrl: SERVER_AVATAR }]]));
  assert.equal(source.calls.members.length, 0, 'search results fill the cache');
});

test("no profile or search result carries an email", async () => {
  const source = fakeSource(people);
  const directory = new MemberDirectory(source);
  const text = JSON.stringify([...(await directory.profiles(SERVER, [ADA, LEFT, GONE])).values(), await directory.search(SERVER, "a")]);
  assert.doesNotMatch(text, /@example\.com|"email"/);
});

test("the discord.js source batches members only with the GuildMembers intent", async () => {
  const cases: [GatewayIntentBits[], boolean][] = [[[GatewayIntentBits.Guilds], false], [[GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], true]];
  for (const [intents, batched] of cases) {
    const fetches: unknown[] = [];
    const sizes: unknown[] = [];
    const avatar = (name: string) => ({ avatarURL: (options?: { size?: number }) => { sizes.push(options?.size); return `https://cdn.discordapp.com/${name}.png`; }, defaultAvatarURL: DEFAULT_AVATAR });
    const member = (id: string) => ({ id, nickname: null, avatarURL: () => null, user: { id, username: `u${id}`, globalName: null, ...avatar(id) } });
    const guild = {
      members: {
        async fetch(arg: string | { user: string[] }) {
          fetches.push(arg);
          if (typeof arg === "string") { if (arg !== ADA) throw new Error("Unknown Member"); return member(arg); }
          return new Map(arg.user.filter(id => id === ADA).map((id): [string, ReturnType<typeof member>] => [id, member(id)]));
        },
        async search(_options: { query: string; limit: number }) { return new Map([[ADA, member(ADA)]]); },
      },
    };
    const client = {
      options: { intents },
      guilds: { cache: new Map([[SERVER, guild]]), async fetch() { return guild; } },
      users: { async fetch(id: string) { return { id, username: `u${id}`, globalName: null, ...avatar(id) }; } },
    } as unknown as Client;
    const source = discordMemberSource(client);
    const found = await source.members(SERVER, [ADA, GONE]);
    assert.deepEqual([...found.keys()], [ADA]);
    assert.deepEqual(fetches, batched ? [{ user: [ADA, GONE] }] : [ADA, GONE]);
    assert.equal((await source.user(GONE)).username, `u${GONE}`);
    assert.deepEqual(await source.search(SERVER, "a", 10).then(list => list.map(item => item.user.id)), [ADA]);
    assert.ok(sizes.length > 0 && sizes.every(size => size === 64), 'avatars are size 64');
  }
});
