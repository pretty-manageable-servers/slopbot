import { Team, TeamMemberMembershipState, type Client } from "discord.js";

export type TeamRole = "owner" | "admin" | "developer" | "read_only";
/** The bot owner's team, reduced to the fields the check reads. Only user IDs are kept. */
export interface TeamSnapshot { ownerId?: string | undefined; members: readonly { id: string; role: string; accepted: boolean }[] }
export interface TeamSource { load(): Promise<TeamSnapshot> }

const RELOAD_MS = 5 * 60 * 1000;
const MEMBER_ROLES = new Set(["admin", "developer", "read_only"]);

export function canEditRole(role: TeamRole | undefined): boolean {
  return role === "owner" || role === "admin" || role === "developer";
}

/** Reads the bot's application through discord.js. A User owner (no team) is the one owner. */
export function discordTeamSource(client: Client): TeamSource {
  return {
    async load() {
      const application = await client.application?.fetch();
      if (!application) throw new Error("Slopbot is not ready yet.");
      const owner = application.owner;
      if (owner instanceof Team) return { ownerId: owner.ownerId ?? undefined, members: [...owner.members.values()].map(member => ({ id: member.id, role: member.role, accepted: member.membershipState === TeamMemberMembershipState.Accepted })) };
      return { ownerId: owner?.id, members: [] };
    },
  };
}

/** Team roles by user ID. Reloads at most every 5 minutes. A failed reload throws, so no role is granted. */
export class TeamAdmins {
  private loaded: { at: number; roles: ReadonlyMap<string, TeamRole> } | undefined;
  private pending: Promise<ReadonlyMap<string, TeamRole>> | undefined;

  constructor(private readonly source: TeamSource, private readonly now: () => number = Date.now) {}

  async role(user: string): Promise<TeamRole | undefined> {
    return (await this.roles()).get(user);
  }

  async canEdit(user: string): Promise<boolean> {
    return canEditRole(await this.role(user));
  }

  private async roles(): Promise<ReadonlyMap<string, TeamRole>> {
    if (this.loaded && this.now() - this.loaded.at < RELOAD_MS) return this.loaded.roles;
    this.pending ??= this.source.load().then(team => { this.loaded = { at: this.now(), roles: teamRoles(team) }; return this.loaded.roles; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}

function teamRoles(team: TeamSnapshot): ReadonlyMap<string, TeamRole> {
  const roles = new Map<string, TeamRole>();
  for (const member of team.members) if (member.accepted) roles.set(member.id, MEMBER_ROLES.has(member.role) ? member.role as TeamRole : "read_only");
  if (team.ownerId) roles.set(team.ownerId, "owner");
  return roles;
}
