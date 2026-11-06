import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { AdminPanel } from "../src/admin-panel.js";
import { loadConfig } from "../src/config.js";
import { ToolError } from "../src/errors.js";
import { MemberDirectory } from "../src/member-directory.js";
import { localConsoleAdmin, localConsoleBackend } from "../src/local/local-console.js";
import { DEFAULT_WORLD_PATH, LOCAL_ONLY, loadLocalWorld } from "../src/local/world.js";
import { TeamAdmins } from "../src/team-admins.js";
import { createUsageMeter } from "../src/usage-meter.js";

// The checked-in fixture: Dev Owner (owner, manages Local Lab), Dev Member (Local Lab only), Outsider (no servers).
const OWNER = "200000000000000001", MEMBER = "200000000000000002", OUTSIDER = "200000000000000003", STRANGER = "200000000000000009";
const LAB = "100000000000000001", SECOND = "100000000000000002";

type Snapshot = {
  user: string;
  server: { id: string; name: string } | null;
  admin?: boolean;
  settings: unknown;
  servers: { id: string; name: string; icon: string | null; admin: boolean }[];
};

async function setup(t: TestContext) {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  const config = loadConfig({ LLM_MODE: "mock", SLOPBOT_PLATFORM: "local" });
  const world = loadLocalWorld(DEFAULT_WORLD_PATH);
  const usage = createUsageMeter(config, store);
  // The local backend reads names from the fixture, so the member directory is never asked anything.
  const members = new MemberDirectory({ members: async () => new Map(), user: async () => { throw new Error("not read in local mode"); }, search: async () => [] });
  const backend = localConsoleBackend({ world, config, store, members, usage });
  const team = new TeamAdmins({ load: async () => ({ ownerId: OWNER, members: [] }) });
  const admin = localConsoleAdmin({ world, team, panel: {} as AdminPanel });
  return { backend, admin };
}

const isLocalOnly = (error: unknown) => error instanceof ToolError && error.message === LOCAL_ONLY;

test("signs in members of a fixture server and refuses everyone else", async t => {
  const { backend } = await setup(t);
  assert.equal(await backend.canSignIn(OWNER), true);
  assert.equal(await backend.canSignIn(MEMBER), true);
  assert.equal(await backend.canSignIn(OUTSIDER), false);
  assert.equal(await backend.canSignIn(STRANGER), false);
});

test("lists the user's servers with the manage flag", async t => {
  const { backend } = await setup(t);
  assert.deepEqual(await backend.servers!(OWNER), [
    { id: LAB, name: "Local Lab", icon: null, admin: true },
    { id: SECOND, name: "Second Lab", icon: null, admin: false },
  ]);
  assert.deepEqual(await backend.servers!(MEMBER), [{ id: LAB, name: "Local Lab", icon: null, admin: false }]);
  assert.deepEqual(await backend.servers!(STRANGER), []);
});

test("profiles come from the fixture, and an unknown user has none", async t => {
  const { backend } = await setup(t);
  assert.deepEqual(await backend.profile!(MEMBER, LAB), { displayName: "Dev Member", avatarUrl: null });
  assert.equal(await backend.profile!(STRANGER, LAB), undefined);
});

test("a snapshot for a user with no servers is empty", async t => {
  const { backend } = await setup(t);
  assert.deepEqual(await backend.snapshot(OUTSIDER) as Snapshot, { user: OUTSIDER, servers: [], server: null });
});

test("a snapshot with no server picks the first server, and gives admins its settings", async t => {
  const { backend } = await setup(t);
  const snapshot = await backend.snapshot(OWNER) as Snapshot;
  assert.deepEqual(snapshot.server, { id: LAB, name: "Local Lab" });
  assert.equal(snapshot.admin, true);
  assert.ok(snapshot.settings && typeof snapshot.settings === "object");
  assert.equal(snapshot.servers.length, 2);
});

test("a snapshot for a chosen server and for a non-admin has no settings", async t => {
  const { backend } = await setup(t);
  const chosen = await backend.snapshot(OWNER, SECOND) as Snapshot;
  assert.deepEqual(chosen.server, { id: SECOND, name: "Second Lab" });
  assert.equal(chosen.admin, false);
  assert.equal(chosen.settings, null);
  const member = await backend.snapshot(MEMBER, LAB) as Snapshot;
  assert.equal(member.admin, false);
  assert.equal(member.settings, null);
});

test("a snapshot for a server the user is not in is refused", async t => {
  const { backend } = await setup(t);
  await assert.rejects(backend.snapshot(MEMBER, SECOND), { message: "Not a member of this server." });
});

test("usage is for members of that server only", async t => {
  const { backend } = await setup(t);
  await assert.rejects(backend.usage!(MEMBER, SECOND), { message: "You and Slopbot are not both in that server." });
  await assert.rejects(backend.usage!(OUTSIDER, LAB), { message: "You and Slopbot are not both in that server." });
  const view = await backend.usage!(MEMBER, LAB) as { windows: unknown[] };
  assert.ok(Array.isArray(view.windows));
});

test("a reset the user has not banked is refused", async t => {
  const { backend } = await setup(t);
  await assert.rejects(backend.useReset!(MEMBER, LAB, "5h"), { message: "You have no banked 5-hour reset." });
  await assert.rejects(backend.useReset!(OUTSIDER, LAB, "week"), { message: "You and Slopbot are not both in that server." });
});

test("calls that need Discord answer LOCAL_ONLY", async t => {
  const { backend, admin } = await setup(t);
  const calls = [
    () => backend.invoke(OWNER, LAB, "channel", "tool", {}),
    () => backend.mcp!(OWNER, LAB, {}),
    () => backend.transcripts!(OWNER, LAB),
    () => backend.setTranscript!(OWNER, LAB, "channel", true),
    () => backend.reply!(OWNER, LAB, "channel", "hi"),
    () => backend.inbox!.list(OWNER, LAB, false),
    () => backend.inbox!.done(OWNER, LAB, "all"),
    () => admin.setTranscript(LAB, "channel", true),
    () => admin.rotateWebhook(LAB, "channel"),
  ];
  for (const call of calls) await assert.rejects(call(), isLocalOnly);
});

test("the admin server list filters by name, ignoring case", async t => {
  const { admin } = await setup(t);
  assert.deepEqual(await admin.servers({ q: "SECOND", offset: 0, limit: 10 }), {
    servers: [{ id: SECOND, name: "Second Lab", icon: null, channelCount: 0, transcriptsOn: 0 }],
    total: 1,
  });
});

test("the admin server list pages through the name-sorted servers", async t => {
  const { admin } = await setup(t);
  const first = await admin.servers({ q: "", offset: 0, limit: 1 }) as { servers: { id: string }[]; total: number };
  assert.equal(first.total, 2);
  assert.deepEqual(first.servers.map(server => server.id), [LAB]);
  const second = await admin.servers({ q: "", offset: 1, limit: 1 }) as { servers: { id: string }[]; total: number };
  assert.deepEqual(second.servers.map(server => server.id), [SECOND]);
});

test("the admin reads team roles, and server info falls back to the ID", async t => {
  const { admin } = await setup(t);
  assert.equal(await admin.role(OWNER), "owner");
  assert.equal(await admin.canEdit(OWNER), true);
  assert.equal(await admin.role(MEMBER), undefined);
  assert.equal(await admin.canEdit(MEMBER), false);
  assert.deepEqual(admin.serverInfo(SECOND), { name: "Second Lab", icon: null });
  assert.deepEqual(admin.serverInfo("100000000000000009"), { name: "100000000000000009", icon: null });
});
