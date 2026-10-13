import test from "node:test";
import assert from "node:assert/strict";
import { Collection, Team, TeamMemberMembershipState, type Client } from "discord.js";
import { discordTeamSource, TeamAdmins, canEditRole, type TeamSnapshot } from "../src/team-admins.js";

const OWNER = "100000000000000001", ADMIN = "100000000000000002", DEVELOPER = "100000000000000003", READER = "100000000000000004", OUTSIDER = "100000000000000005", INVITED = "100000000000000006";
const FIVE_MINUTES = 5 * 60 * 1000;
const team = (members: TeamSnapshot["members"]): TeamSnapshot => ({ ownerId: OWNER, members });
const accepted = (id: string, role: string) => ({ id, role, accepted: true });

test("team roles come from the Developer Portal team, and only editors can edit", async () => {
  const admins = new TeamAdmins({ async load() { return team([accepted(ADMIN, "admin"), accepted(DEVELOPER, "developer"), accepted(READER, "read_only"), { id: INVITED, role: "admin", accepted: false }]); } });
  assert.equal(await admins.role(OWNER), "owner");
  assert.equal(await admins.role(ADMIN), "admin");
  assert.equal(await admins.role(DEVELOPER), "developer");
  assert.equal(await admins.role(READER), "read_only");
  assert.equal(await admins.role(OUTSIDER), undefined);
  assert.equal(await admins.role(INVITED), undefined, "an invitation that is not accepted grants nothing");
  assert.deepEqual([await admins.canEdit(OWNER), await admins.canEdit(ADMIN), await admins.canEdit(DEVELOPER)], [true, true, true]);
  assert.deepEqual([await admins.canEdit(READER), await admins.canEdit(OUTSIDER), await admins.canEdit(INVITED)], [false, false, false]);
  assert.equal(canEditRole(undefined), false);
});

test("an unknown team role is read only", async () => {
  const admins = new TeamAdmins({ async load() { return team([accepted(ADMIN, "send_messages_only")]); } });
  assert.equal(await admins.role(ADMIN), "read_only");
  assert.equal(await admins.canEdit(ADMIN), false);
});

test("a team owner is read from the Team object, by user ID", async () => {
  const members = new Collection([
    [ADMIN, { id: ADMIN, role: "admin", membershipState: TeamMemberMembershipState.Accepted }],
    [READER, { id: READER, role: "read_only", membershipState: TeamMemberMembershipState.Accepted }],
    [INVITED, { id: INVITED, role: "developer", membershipState: TeamMemberMembershipState.Invited }],
  ]);
  const application = { owner: Object.assign(Object.create(Team.prototype), { ownerId: OWNER, members }) };
  const admins = new TeamAdmins(discordTeamSource({ application: { fetch: async () => application } } as unknown as Client));
  assert.equal(await admins.role(OWNER), "owner");
  assert.equal(await admins.role(ADMIN), "admin");
  assert.equal(await admins.role(READER), "read_only");
  assert.equal(await admins.role(INVITED), undefined);
});

test("when the bot application is owned by a user, that user is the owner", async () => {
  const application = { owner: { id: OWNER } };
  const admins = new TeamAdmins(discordTeamSource({ application: { fetch: async () => application } } as unknown as Client));
  assert.equal(await admins.role(OWNER), "owner");
  assert.equal(await admins.role(ADMIN), undefined);
  assert.equal(await admins.canEdit(OWNER), true);
});

test("the team loads again after 5 minutes, and a removed member loses access then", async () => {
  let now = 0, loads = 0, members = [accepted(DEVELOPER, "developer")];
  const admins = new TeamAdmins({ async load() { loads++; return team([...members]); } }, () => now);
  assert.equal(await admins.canEdit(DEVELOPER), true);
  now = FIVE_MINUTES - 1;
  assert.equal(await admins.canEdit(DEVELOPER), true);
  assert.equal(loads, 1, "no reload before 5 minutes");
  members = [];
  now = FIVE_MINUTES;
  assert.equal(await admins.role(DEVELOPER), undefined);
  assert.equal(loads, 2, "reload at 5 minutes");
});

test("concurrent checks share one team load, and a failed reload grants no role", async () => {
  let now = 0, loads = 0, failing = false;
  const admins = new TeamAdmins({ async load() { loads++; if (failing) throw new Error("Discord is down"); return team([accepted(ADMIN, "admin")]); } }, () => now);
  await Promise.all([admins.role(ADMIN), admins.role(OWNER), admins.canEdit(ADMIN)]);
  assert.equal(loads, 1);
  failing = true; now = FIVE_MINUTES;
  await assert.rejects(admins.role(ADMIN), /Discord is down/);
  assert.equal(loads, 2);
});
