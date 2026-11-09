// Fake bot data for Storybook and `pnpm dev:mock`: one user, DerpZ, in two servers, with a few chats. Handlers
// (handlers.ts) serve it; stories that need other data override one handler with `parameters.msw.handlers`.
import type { AdminMe, ChatSummary, ServerShare, ServerSnapshot, ServerSummary, Session, Status } from "../api-types";

const HOUR = 3_600_000;
/** A fixed "now", so dates in stories do not change from day to day. */
export const NOW = Date.UTC(2026, 10, 8, 12);

export const servers: ServerSummary[] = [
  { id: "100000000000000001", name: "Houseoverwatch", icon: null, admin: true },
  { id: "100000000000000002", name: "Second Lab", icon: null, admin: false },
];
export const [houseoverwatch, secondLab] = servers as [ServerSummary, ServerSummary];

export const session: Session = {
  user: "200000000000000001",
  me: { displayName: "DerpZ", avatarUrl: null },
  servers,
  csrf: "mock",
};

export const chats: ChatSummary[] = [
  { id: "c1", title: "Why is my Postgres slow", updated: NOW - HOUR, effort: "medium" },
  { id: "c2", title: "Birthday message for Sam", updated: NOW - 26 * HOUR, effort: "low" },
  { id: "c3", title: "A very long chat title that does not fit in the drawer at all, not even close", updated: NOW - 80 * HOUR, effort: "xhigh" },
];

export const channels = [
  { id: "300000000000000001", name: "general", monitored: true },
  { id: "300000000000000002", name: "memes", monitored: false },
];

/** The settings snapshot of `server`, as a manager of it sees it. */
export const snapshot = (server: ServerSummary = houseoverwatch): ServerSnapshot => ({
  user: session.user,
  servers,
  server: { id: server.id, name: server.name },
  admin: server.admin,
  channels,
  me: { id: session.user, displayName: "DerpZ", avatarUrl: null },
  profile: undefined,
  mcp: null,
  settings: null,
});

export const adminMe: AdminMe = { role: "owner", canEdit: true };
export const status: Status = { mode: "normal", canChat: true };

export const shares: ServerShare[] = [
  { id: "s1aaaaaaaaaaaaaaaaaa", channel: channels[0]!.id, created_at: NOW - 7 * 24 * HOUR, revoked: false },
  { id: "s2aaaaaaaaaaaaaaaaaa", channel: channels[1]!.id, created_at: NOW - 19 * 24 * HOUR, revoked: true },
];

/** Links shared from a thread. The thread is not in the server's channel list, so the table shows its ID. */
export const threadShares: ServerShare[] = [
  { id: "t1aaaaaaaaaaaaaaaaaa", channel: "300000000000000099", created_at: NOW - 2 * HOUR, revoked: false },
];
