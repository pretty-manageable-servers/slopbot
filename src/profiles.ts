import type { Json, Message } from "./domain.js";
import { ToolError, type ToolRegistry } from "./tools.js";
import { globalProfiles } from './global-profiles.js';

export interface ProfileField {
  field: string; value: Json; editor: string; sourceIds: string[]; revision: string;
}
export interface UserProfile {
  userId: string; name: string; identity: Record<string, string>; allowEdits: boolean; fields: ProfileField[];
}
type Result<T> = T | Promise<T>;
export interface ProfileStore {
  profile(server: string, user: string): Result<UserProfile>;
  findPeople(server: string, query: string): Result<{ id: string; name: string }[]>;
  editProfile(message: Message, user: string, field: string, value: Json, operation: string): Result<string>;
  lockProfile(server: string, user: string, actor: string, allow: boolean): Result<void>;
  profileHistory(server: string, user: string, actor: string): Result<ProfileField[]>;
  undoProfile(message: Message, user: string, revision: string, operation: string): Result<string>;
}
export function registerProfileTools(registry: ToolRegistry, store: ProfileStore): void {
  registry.register({
    name: "profile", surface: "top", description: "Find or inspect profiles; explicitly add attributed facts, aliases or links. scope:server is this server's profile, scope:global is the same account profile across servers, editable only by its owner. Global fields persist until the owner removes them and override conflicting server fields in model context. Never infer personal facts from jokes or guesses.",
    access: "member", effect: "write", retrySafe: true, execution: "inline",
    fields: {
      action: { type: "string", description: "Default: get. History and undo are owner-only.", choices: ["get", "find", "set", "remove", "lock", "history", "undo"] },
      scope: { type: 'string', description: 'Default server. Global fields are public across servers and only the owner can edit them.', choices: ['server', 'global'] },
      user: { type: "string", description: "Discord mention, ID or exact name; defaults to requester" },
      field: { type: "string", description: "Custom field, e.g. real_name, nicknames, github or interests" },
      value: { type: "json", description: "Field value, preferably a string or a list of strings" },
      allow_edits: { type: "boolean", description: "Owner only: permit edits by other members" },
      revision: { type: "string", description: "Current field revision to undo" },
    },
    publicResult: args => (args.action ?? "get") === "get",
    writes: args => ["set", "remove", "lock", "undo"].includes(String(args.action ?? "get")),
    resource: (message, args) => args.scope === 'global' ? `profiles:global:${String(args.user ?? message.author)}` : `profiles:${message.server}`,
    async execute(context, args) {
      const action = String(args.action ?? "get"), query = String(args.user ?? `<@${context.message.author}>`);
      const people = await store.findPeople(context.message.server, query);
      if (action === "find") return people.length ? people.map(person => `${person.name} (<@${person.id}>)`).join("\n") : "No matching member. Use a Discord mention.";
      const global = args.scope === 'global';
      const explicitId = global ? query.match(/^<@!?(\d+)>$/)?.[1] ?? (/^\d+$/.test(query) ? query : undefined) : undefined;
      if (explicitId && !people.length) people.push({ id: explicitId, name: explicitId });
      if (people.length !== 1) throw new ToolError(people.length ? "That name is ambiguous. Use a Discord mention." : "Unknown member. Use a Discord mention for someone in an indexed channel.");
      const user = people[0]!.id;
      await context.assertActive();
      if (global) {
        const profiles = globalProfiles(store);
        if (!profiles) throw new ToolError('Global profile storage is unavailable.');
        if (action === 'lock') {
          if (user !== context.message.author) throw new ToolError('Only the profile owner may change a global profile.');
          if (args.allow_edits !== false) throw new ToolError('Global profiles are always owner-only. Other members and admins cannot be granted edit access.');
          return 'Global profiles are always owner-only.';
        }
        if (action === 'history') return JSON.stringify(await profiles.history(user, context.message.author));
        if (action === 'undo') {
          if (!args.revision) throw new ToolError('Choose a revision from your global profile history.');
          return profiles.undo(user, context.message.author, String(args.revision), context.operationId);
        }
        if (action === 'set' || action === 'remove') {
          if (!args.field || action === 'set' && args.value === undefined) throw new ToolError('Choose a field and supply its value.');
          return profiles.edit(user, context.message.author, String(args.field), action === 'remove' ? null : args.value!, context.operationId);
        }
        const profile = await profiles.get(user);
        return `Global profile (<@${user}>), shared across servers. Only the owner may edit.\n` + (profile.fields.map(field => `${field.field}: ${JSON.stringify(field.value)} (self-reported; ${field.revision})`).join('\n') || 'No global fields yet.');
      }
      if (action === "lock") {
        if (typeof args.allow_edits !== "boolean") throw new ToolError("Set allow_edits to true or false.");
        await store.lockProfile(context.message.server, user, context.message.author, args.allow_edits);
        return "Profile edit permission updated.";
      }
      if (action === "undo") {
        if (!args.revision) throw new ToolError("Choose a revision from your profile history.");
        return store.undoProfile(context.message, user, String(args.revision), context.operationId);
      }
      if (action === "history") return JSON.stringify(await store.profileHistory(context.message.server, user, context.message.author));
      if (action === "set" || action === "remove") {
        if (!args.field || (action === "set" && args.value === undefined)) throw new ToolError("Choose a field and supply its value.");
        return store.editProfile(context.message, user, String(args.field), action === "remove" ? null : args.value!, context.operationId);
      }
      const profile = await store.profile(context.message.server, user);
      return `${profile.name} (<@${profile.userId}>)\nDiscord identity: ${JSON.stringify(profile.identity)}\nOther members may edit: ${profile.allowEdits}\n` +
        (profile.fields.map(field => `${field.field}: ${JSON.stringify(field.value)} — ${field.editor === user ? "self-reported" : `added by <@${field.editor}>; unconfirmed by owner`} (${field.revision})`).join("\n") || "No custom fields yet.");
    },
  });
}

export async function replySubject(store: ProfileStore | undefined, server: string, text: string): Promise<{id: string; name: string} | undefined> {
  if (!store) return undefined;
  const mentions = [...new Set([...text.matchAll(/<@!?(\d{17,20})>/g)].map(match => match[1]!))];
  if (mentions.length !== 1) return undefined;
  const people = await store.findPeople(server, `<@${mentions[0]}>`);
  return people.length === 1 ? people[0] : undefined;
}
