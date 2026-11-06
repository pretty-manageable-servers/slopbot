import { readFileSync } from "node:fs";

/** A fixture server. Local mode has no Discord, so these stand in for the servers Slopbot runs in. */
export interface LocalWorldServer { id: string; name: string; icon: string | null }
export interface LocalUser {
  /** A Discord-style snowflake: /^\d{17,20}$/. */
  id: string;
  /** The display name and the username. */
  name: string;
  avatarUrl: string | null;
  /** Server IDs. Each must be in LocalWorld.servers. */
  servers: string[];
  /** Server IDs where the user has Manage Server. A subset of servers. */
  manage: string[];
  team?: "owner" | "admin" | "developer" | "read_only";
}
export interface LocalWorld { bot: { id: string; name: string }; servers: LocalWorldServer[]; users: LocalUser[] }

export const DEFAULT_WORLD_PATH = "dev/local-world.json";
export const LOCAL_ONLY = "Not available in local mode.";

const SNOWFLAKE = /^\d{17,20}$/;
const TEAM_ROLES = ["owner", "admin", "developer", "read_only"];

/** Reads and checks the fixture. */
export function loadLocalWorld(path: string): LocalWorld {
  return parseLocalWorld(JSON.parse(readFileSync(path, "utf8")));
}

/** Checks the fixture. Throws an Error that names the bad field. */
export function parseLocalWorld(json: unknown): LocalWorld {
  const fail = (field: string, problem: string): never => { throw new Error(`local-world: ${field} ${problem}`); };
  const object = (value: unknown, field: string): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail(field, "is not an object");
  const text = (value: unknown, field: string): string => typeof value === "string" && value.trim() ? value : fail(field, "is not a non-empty string");
  const id = (value: unknown, field: string): string => typeof value === "string" && SNOWFLAKE.test(value) ? value : fail(field, "is not a Discord ID");
  const nullableText = (value: unknown, field: string): string | null => value === null ? null : text(value, field);
  const array = (value: unknown, field: string): unknown[] => Array.isArray(value) ? value : fail(field, "is not an array");

  const root = object(json, "root");
  const botJson = object(root.bot, "bot");
  const bot = { id: id(botJson.id, "bot.id"), name: text(botJson.name, "bot.name") };
  const seen = new Set<string>([bot.id]);
  const unique = (value: string, field: string): string => {
    if (seen.has(value)) fail(field, "is a duplicate id");
    seen.add(value);
    return value;
  };
  const servers = array(root.servers, "servers").map((value, index) => {
    const field = `servers[${index}]`, server = object(value, field);
    return { id: unique(id(server.id, `${field}.id`), `${field}.id`), name: text(server.name, `${field}.name`), icon: nullableText(server.icon, `${field}.icon`) };
  });
  const serverIds = new Set(servers.map(server => server.id));
  const users = array(root.users, "users").map((value, index): LocalUser => {
    const field = `users[${index}]`, user = object(value, field);
    const ids = (key: string) => array(user[key], `${field}.${key}`).map((entry, at) => id(entry, `${field}.${key}[${at}]`));
    const userServers = ids("servers"), manage = ids("manage");
    userServers.forEach((server, at) => { if (!serverIds.has(server)) fail(`${field}.servers[${at}]`, "is an unknown server"); });
    manage.forEach((server, at) => { if (!userServers.includes(server)) fail(`${field}.manage[${at}]`, "is a manage server not in servers"); });
    if (user.team !== undefined && !TEAM_ROLES.includes(user.team as string)) fail(`${field}.team`, `is not one of ${TEAM_ROLES.join(", ")}`);
    return {
      id: unique(id(user.id, `${field}.id`), `${field}.id`), name: text(user.name, `${field}.name`),
      avatarUrl: nullableText(user.avatarUrl ?? null, `${field}.avatarUrl`), servers: userServers, manage,
      ...(user.team !== undefined ? { team: user.team as NonNullable<LocalUser["team"]> } : {}),
    };
  });
  return { bot, servers, users };
}
