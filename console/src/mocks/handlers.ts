// MSW handlers for the bot's console API, keyed by name so a story replaces one of them:
//   parameters: { msw: { handlers: { shares: http.get("/api/shares", () => HttpResponse.json(...)) } } }
// Calls with no handler warn in the browser console, so a missing mock is easy to spot.
import type { EngineEnvelope, EngineEvent } from "@slopbot/contracts";
import { HttpResponse, delay, http, type HttpHandler } from "msw";
import { sse } from "msw/sse";
import * as data from "./data";

const server = (request: Request) => data.servers.find((s) => s.id === new URL(request.url).searchParams.get("server")) ?? data.houseoverwatch;

export const handlers = {
  session: http.get("/api/session", () => HttpResponse.json(data.session)),
  chats: http.get("/api/chats", () => HttpResponse.json(data.chats)),
  settings: http.get("/api/settings", ({ request }) => HttpResponse.json({ data: data.snapshot(server(request)), csrf: "mock" })),
  adminMe: http.get("/api/admin/me", () => HttpResponse.json(data.adminMe)),
  status: http.get("/api/status", () => HttpResponse.json(data.status)),
  shares: http.get("/api/shares", () => HttpResponse.json({ shares: data.shares })),

  // Pages and parts: chats, channels, Inbox, usage and shares. The event streams send nothing by default; a story
  // that shows live replies overrides them with the envelopes of data.chatLive.
  conversations: http.get("/api/conversations", () => HttpResponse.json({ conversations: data.conversations })),
  inbox: http.get("/api/servers/:server/inbox", ({ request }) => {
    const done = new URL(request.url).searchParams.has("done");
    return HttpResponse.json({ items: data.inbox.filter((item) => done || !item.done_at) });
  }),
  inboxDone: http.post("/api/servers/:server/inbox/done", () => HttpResponse.json({ changed: 1 })),
  channelMessages: http.get("/api/conversations/:channel/messages", ({ params }) => HttpResponse.json(data.transcript(params.channel as string))),
  channelUsed: http.get("/api/conversations/:channel/used", () => HttpResponse.json({ used: [] })),
  channelRuns: http.get("/api/conversations/:channel/runs", () => HttpResponse.json({ conversations: data.runs, hasMore: false })),
  channelRun: http.get("/api/conversations/:channel/runs/:run", ({ params }) => {
    const run = data.runs.find((r) => r.id === params.run) ?? data.runs[0]!;
    const page = data.transcript(params.channel as string);
    return HttpResponse.json({ ...page, conversation: { ...run, runIds: [run.id] }, messages: page.messages.filter((m) => m.runIds.includes(run.id)) });
  }),
  channelTurn: http.get("/api/conversations/:channel/turns/:turn/events", () => HttpResponse.json({ events: [] })),
  channelEvents: sse("/api/conversations/:channel/events", () => {}),
  channelReply: http.post("/api/conversations/:channel/reply", () => HttpResponse.json({ id: "r-new", messageId: "m-new", status: "posted", via: "bot" })),
  chatMessages: http.get("/api/chats/:id/messages", () => HttpResponse.json({ messages: data.chatSaved, hasMore: false, streamId: 1 })),
  chatTurn: http.get("/api/chats/:id/turns/:turn/events", () => HttpResponse.json({ events: data.chatSavedTurn })),
  chatEvents: sse("/api/chats/:id/events", () => {}),
  createChat: http.post("/api/chats", () => HttpResponse.json({ id: "c-new" })),
  sendChat: http.post("/api/chats/:id/messages", () => HttpResponse.json({ id: "m-new" })),
  usage: http.get("/api/usage", () => HttpResponse.json(data.usage)),
  createShare: http.post("/api/shares", () => HttpResponse.json({ id: data.shareData.id })),
} satisfies Record<string, HttpHandler>;

/** A stream at `url` that sends these engine events, as the bot's `engine` events, then stays open. */
export const engineStream = (url: string, events: EngineEvent[], channel: string) =>
  sse<{ engine: EngineEnvelope }>(url, ({ client }) => {
    for (const envelope of data.envelopes(events, channel)) client.send({ event: "engine", data: envelope });
  });

/** The bot's error body for a status, as `ApiError` reads it. */
export const failure = (status: number, error: string) => HttpResponse.json({ error }, { status });
/** A route that never answers: the loading state. */
export const forever = (path: string) => http.get(path, async () => { await delay("infinite"); return HttpResponse.json({}); });
