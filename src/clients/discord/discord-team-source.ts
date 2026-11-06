import { Team, TeamMemberMembershipState, type Client } from "discord.js";
import type { TeamSource } from "../../team-admins.js";

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
