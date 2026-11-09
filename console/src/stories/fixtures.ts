// Data for stories: one user in two servers, a few chats, and the settings of the first server. Stories spread
// `baseRoutes` and override the routes they are about.
import type { AdminMe, ChatSummary, ServerSnapshot, ServerSummary, Session, Status as LlmStatus } from "../api-types";
import type { Routes } from "./mock-api";

const HOUR = 3_600_000;
const now = Date.UTC(2026, 10, 8, 12);

export const servers: ServerSummary[] = [
  { id: "100000000000000001", name: "Houseoverwatch", icon: null, admin: true },
  { id: "100000000000000002", name: "Second Lab", icon: null, admin: false },
];

export const session: Session = {
  user: "200000000000000001",
  me: { displayName: "DerpZ", avatarUrl: null },
  servers,
  csrf: "story",
};

export const chats: ChatSummary[] = [
  { id: "c1", title: "Why is my Postgres slow", updated: now - HOUR, effort: "medium" },
  { id: "c2", title: "Birthday message for Sam", updated: now - 26 * HOUR, effort: "low" },
  { id: "c3", title: "A very long chat title that does not fit in the drawer at all", updated: now - 80 * HOUR, effort: "xhigh" },
];

export const snapshot: ServerSnapshot = {
  user: session.user,
  servers,
  server: { id: servers[0]!.id, name: servers[0]!.name },
  admin: true,
  channels: [
    { id: "300000000000000001", name: "general", monitored: true },
    { id: "300000000000000002", name: "memes", monitored: false },
  ],
  me: { id: session.user, displayName: "DerpZ", avatarUrl: null },
  profile: undefined,
  mcp: null,
  settings: null,
};

export const adminMe: AdminMe = { role: "owner", canEdit: true };
const status: LlmStatus = { mode: "normal", canChat: true };

/** Enough of the bot for the frame and the drawer: session, chats, settings of the picked server, status. */
export const baseRoutes: Routes = {
  "GET /api/session": session,
  "GET /api/chats": chats,
  "GET /api/settings": ({ url }: { url: URL }) => ({ data: { ...snapshot, server: { id: url.searchParams.get("server"), name: servers.find((s) => s.id === url.searchParams.get("server"))?.name } }, csrf: "story" }),
  "GET /api/admin/me": adminMe,
  "GET /api/status": status,
};
