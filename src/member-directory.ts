import { GatewayIntentBits, IntentsBitField, type Client, type GuildMember, type User } from "discord.js";

/** A Discord user as the web console shows them. avatarUrl is null only when the user is unknown. */
export interface MemberProfile { id: string; displayName: string; username: string | null; avatarUrl: string | null }
/** The Discord facts of one user. avatarUrl is the global avatar (size 64) or null. */
export interface MemberUser { id: string; username: string; globalName: string | null; avatarUrl: string | null; defaultAvatarUrl: string }
/** One server member. avatarUrl is the server avatar (size 64) or null. */
export interface MemberRecord { user: MemberUser; nickname: string | null; avatarUrl: string | null }

/** The Discord access the directory needs. The discord.js version is below; tests pass a fake. */
export interface MemberSource {
  /** Members of the server with these IDs. IDs that are not members are left out. */
  members(server: string, ids: readonly string[]): Promise<Map<string, MemberRecord>>;
  /** A user by ID, for users who are not in the server any more. Throws when Discord does not know the user. */
  user(id: string): Promise<MemberUser>;
  /** Members whose name or nickname starts with the query. */
  search(server: string, query: string, limit: number): Promise<MemberRecord[]>;
}

export const UNKNOWN_USER = "Unknown user";
const SNOWFLAKE = /^\d{17,20}$/;
const TTL_MS = 10 * 60 * 1000;
// A failed lookup is kept for less time, so a short Discord outage does not hide names for 10 minutes.
const FAILED_TTL_MS = 60 * 1000;
const SEARCH_LIMIT = 25;
const CACHE_MAX = 10000;
const BATCH = 100;
const PARALLEL = 5;

function unknown(id: string): MemberProfile {
  return { id, displayName: UNKNOWN_USER, username: null, avatarUrl: null };
}

/** Server nickname, then global name, then username. The avatar is the server one, then the user one, then the default. */
function profileOf(id: string, user: MemberUser, member?: MemberRecord): MemberProfile {
  return {
    id,
    displayName: member?.nickname || user.globalName || user.username,
    username: user.username,
    avatarUrl: member?.avatarUrl ?? user.avatarUrl ?? user.defaultAvatarUrl,
  };
}

/** Resolves Discord users for one server. Results are cached for 10 minutes. Lookups never throw for one user. */
export class MemberDirectory {
  private readonly cache = new Map<string, { profile: MemberProfile; until: number }>();

  constructor(private readonly source: MemberSource, private readonly now: () => number = Date.now) {}

  /** One profile for each ID. A user who cannot be found gets the Unknown user profile. */
  async profiles(server: string, ids: readonly string[]): Promise<Map<string, MemberProfile>> {
    const found = new Map<string, MemberProfile>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const hit = this.cached(server, id);
      if (hit) found.set(id, hit);
      else if (SNOWFLAKE.test(id)) missing.push(id);
      else found.set(id, this.keep(server, unknown(id)));
    }
    if (missing.length) {
      const members = await this.source.members(server, missing).catch(() => new Map<string, MemberRecord>());
      await mapLimit(missing, PARALLEL, async id => {
        found.set(id, this.keep(server, await this.resolve(id, members.get(id))));
      });
    }
    return found;
  }

  /** Members whose name starts with the query. An empty query gives no results. Discord errors are thrown. */
  async search(server: string, query: string, limit = 10): Promise<MemberProfile[]> {
    const text = query.trim();
    if (!text) return [];
    const max = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), SEARCH_LIMIT) : 10;
    const records = await this.source.search(server, text, max);
    return records.map(record => this.keep(server, profileOf(record.user.id, record.user, record)));
  }

  private async resolve(id: string, member: MemberRecord | undefined): Promise<MemberProfile> {
    if (member) return profileOf(id, member.user, member);
    try { return profileOf(id, await this.source.user(id)); }
    catch { return unknown(id); }
  }

  private cached(server: string, id: string): MemberProfile | undefined {
    const key = JSON.stringify([server, id]);
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (hit.until > this.now()) return hit.profile;
    this.cache.delete(key);
    return undefined;
  }

  private keep(server: string, profile: MemberProfile): MemberProfile {
    const failed = profile.username === null;
    if (this.cache.size >= CACHE_MAX) this.prune();
    this.cache.set(JSON.stringify([server, profile.id]), { profile, until: this.now() + (failed ? FAILED_TTL_MS : TTL_MS) });
    return profile;
  }

  /** Drops expired entries. If none expired, drops the oldest half so the map stays bounded. */
  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.cache) if (value.until <= now) this.cache.delete(key);
    if (this.cache.size < CACHE_MAX) return;
    let drop = Math.floor(this.cache.size / 2);
    for (const key of this.cache.keys()) { if (drop-- <= 0) break; this.cache.delete(key); }
  }
}

async function mapLimit<T>(items: readonly T[], size: number, task: (item: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < items.length; offset += size) await Promise.all(items.slice(offset, offset + size).map(task));
}

function userOf(user: User): MemberUser {
  return { id: user.id, username: user.username, globalName: user.globalName, avatarUrl: user.avatarURL({ size: 64 }) ?? null, defaultAvatarUrl: user.defaultAvatarURL };
}

function recordOf(member: GuildMember): MemberRecord {
  return { user: userOf(member.user), nickname: member.nickname, avatarUrl: member.avatarURL({ size: 64 }) ?? null };
}

/**
 * The discord.js side. A batch fetch by user ID needs the GuildMembers gateway intent. Without it,
 * each member is fetched by REST, which needs no privileged intent.
 */
export function discordMemberSource(client: Client): MemberSource {
  const batchAllowed = () => Boolean(client.options?.intents) && new IntentsBitField(client.options.intents).has(GatewayIntentBits.GuildMembers);
  const guildOf = async (server: string) => client.guilds.cache.get(server) ?? await client.guilds.fetch(server);
  return {
    async members(server, ids) {
      const guild = await guildOf(server);
      const found = new Map<string, MemberRecord>();
      const single: string[] = [];
      if (batchAllowed()) {
        for (let offset = 0; offset < ids.length; offset += BATCH) {
          const chunk = ids.slice(offset, offset + BATCH);
          const fetched = await guild.members.fetch({ user: chunk }).catch(() => undefined);
          if (fetched) for (const member of fetched.values()) found.set(member.id, recordOf(member));
          else single.push(...chunk);
        }
      } else single.push(...ids);
      await mapLimit(single, PARALLEL, async id => {
        const member = await guild.members.fetch(id).catch(() => undefined);
        if (member) found.set(id, recordOf(member));
      });
      return found;
    },
    async user(id) {
      return userOf(await client.users.fetch(id));
    },
    async search(server, query, limit) {
      const guild = await guildOf(server);
      const found = await guild.members.search({ query, limit });
      return [...found.values()].map(recordOf);
    },
  };
}
