// MSW handlers for the bot's console API, keyed by name so a story replaces one of them:
//   parameters: { msw: { handlers: { shares: http.get("/api/shares", () => HttpResponse.json(...)) } } }
// Calls with no handler warn in the browser console, so a missing mock is easy to spot.
import { HttpResponse, delay, http, type HttpHandler } from "msw";
import * as data from "./data";

const server = (request: Request) => data.servers.find((s) => s.id === new URL(request.url).searchParams.get("server")) ?? data.houseoverwatch;

export const handlers = {
  session: http.get("/api/session", () => HttpResponse.json(data.session)),
  chats: http.get("/api/chats", () => HttpResponse.json(data.chats)),
  settings: http.get("/api/settings", ({ request }) => HttpResponse.json({ data: data.snapshot(server(request)), csrf: "mock" })),
  adminMe: http.get("/api/admin/me", () => HttpResponse.json(data.adminMe)),
  status: http.get("/api/status", () => HttpResponse.json(data.status)),
  shares: http.get("/api/shares", () => HttpResponse.json({ shares: data.shares })),
  revokeShare: http.post("/api/shares/:id/revoke", () => HttpResponse.json({})),
  revokeAllShares: http.post("/api/shares/revoke-all", () => HttpResponse.json({ revoked: data.shares.filter((s) => !s.revoked).length })),
} satisfies Record<string, HttpHandler>;

/** The bot's error body for a status, as `ApiError` reads it. */
export const failure = (status: number, error: string) => HttpResponse.json({ error }, { status });
/** A route that never answers: the loading state. */
export const forever = (path: string) => http.get(path, async () => { await delay("infinite"); return HttpResponse.json({}); });
