import type { MemberRecord, MemberSource, MemberUser } from "../src/member-directory.js";

/** A fake person. Extra fields (an email, say) must never reach a response. */
export interface FakePerson { username: string; globalName?: string | null; nickname?: string | null; avatar?: string | null; serverAvatar?: string | null; inServer?: boolean; email?: string }

export const DEFAULT_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";

/** A Discord member source with fixed people. It counts calls, so tests can check the cache. */
export function fakeSource(people: Record<string, FakePerson>) {
  const calls = { members: [] as string[][], users: [] as string[], search: [] as { query: string; limit: number }[] };
  const userOf = (id: string, person: FakePerson): MemberUser => ({ id, username: person.username, globalName: person.globalName ?? null, avatarUrl: person.avatar ?? null, defaultAvatarUrl: DEFAULT_AVATAR });
  const recordOf = (id: string, person: FakePerson): MemberRecord => ({ user: userOf(id, person), nickname: person.nickname ?? null, avatarUrl: person.serverAvatar ?? null });
  const source: MemberSource & { calls: typeof calls } = {
    calls,
    async members(_server, ids) {
      calls.members.push([...ids]);
      const found = new Map<string, MemberRecord>();
      for (const id of ids) {
        const person = people[id];
        if (person?.inServer) found.set(id, recordOf(id, person));
      }
      return found;
    },
    async user(id) {
      calls.users.push(id);
      const person = people[id];
      if (!person) throw new Error("Unknown User");
      return userOf(id, person);
    },
    async search(_server, query, limit) {
      calls.search.push({ query, limit });
      const needle = query.toLowerCase();
      return Object.entries(people)
        .filter(([, person]) => person.inServer && [person.nickname, person.globalName, person.username].some(name => name?.toLowerCase().startsWith(needle)))
        .slice(0, limit)
        .map(([id, person]) => recordOf(id, person));
    },
  };
  return source;
}
