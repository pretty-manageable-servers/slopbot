// Fake bot data for Storybook and `pnpm dev:mock`: one user, DerpZ, in two servers, with a few chats. Handlers
// (handlers.ts) serve it; stories that need other data override one handler with `parameters.msw.handlers`.
import type { EngineEnvelope, EngineEvent, ShareData } from "@slopbot/contracts";
import type { BotMessage } from "../events";
import type { AdminMe, ChatSummary, Conversation, ConversationSummary, InboxItem, ServerShare, ServerSnapshot, ServerSummary, Session, Status, TranscriptPage, Usage } from "../api-types";

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

// Pages and parts: chats, channels, Inbox, usage and a share. Each route's handler is in handlers.ts (its own block).
const BOT = "200000000000000000";
const SAM = "200000000000000002";
const ARI = "200000000000000003";
const GENERAL = "300000000000000001";
const MEMES = "300000000000000002";
const BUILD_THREAD = "300000000000000003";

/** The saved messages of chat c1: a question and the answer, which has its turn and its run. */
export const chatSaved: BotMessage[] = [
  { id: "m1", channel: "c1", author: session.user, authorName: "DerpZ", username: null, avatarUrl: null, text: "Why is my Postgres slow", timestamp: NOW - HOUR, editedAt: null, slopbot: false, runIds: [], used: false },
  { id: "m2", channel: "c1", author: BOT, authorName: "Slopbot", username: null, avatarUrl: null, text: "Usually a missing index. Run `EXPLAIN ANALYZE` on the slowest query and look for a sequential scan on a big table.", timestamp: NOW - HOUR + 40_000, editedAt: null, slopbot: true, runIds: ["r-c1"], used: false, turn: "m1" },
];

/** A live turn: a new question and its answer as it streams in. The chat's event stream sends these. */
export const chatLive: EngineEvent[] = [
  { type: "message.upsert", message: { id: "m3", channel: "c1", author: session.user, authorName: "DerpZ", username: null, avatarUrl: null, text: "Can you check the orders table too?", timestamp: NOW, editedAt: null, slopbot: false, runIds: [], used: false } },
  { type: "turn.start", turn: "m3" },
  { type: "round.start", turn: "m3", run: "r-live" },
  { type: "thinking.delta", turn: "m3", run: "r-live", text: "The user wants the orders table checked. Start with its indexes." },
  { type: "text.delta", turn: "m3", run: "r-live", text: "The orders table has no index on `customer_id`, and the" },
];

/** The steps of the saved reply to m1: thinking, one tool call and the end. Loaded from /turns/m1/events. */
export const chatSavedTurn: EngineEvent[] = [
  { type: "turn.start", turn: "m1" },
  { type: "round.start", turn: "m1", run: "r-c1" },
  { type: "thinking.delta", turn: "m1", run: "r-c1", text: "Slow Postgres queries are usually a scan or a lock. Check the plan first." },
  { type: "tool.status", turn: "m1", call: "call_explain_1", name: "explain_query", status: "completed", input: { query: "select * from orders where customer_id = 42" }, result: "Seq Scan on orders (cost=0.00..18334.00 rows=52)", durationMs: 412 },
  { type: "text.delta", turn: "m1", run: "r-c1", text: "Usually a missing index." },
  { type: "turn.end", turn: "m1", status: "done" },
];

/** The engine events as the stream sends them: envelopes numbered from 1, in the chat's conversation. */
export const envelopes = (events: EngineEvent[], channel: string, server = houseoverwatch.id): EngineEnvelope[] =>
  events.map((event, i) => ({ seq: i + 1, at: NOW + i, conversation: { server, channel }, event }));

export const conversations: Conversation[] = [
  { id: GENERAL, name: "general", kind: "channel", parent: null, newest: NOW - HOUR, canSend: true, enabled: true },
  { id: BUILD_THREAD, name: "Why is the build red", kind: "thread", parent: GENERAL, newest: NOW - 2 * HOUR, canSend: true, enabled: true },
  { id: MEMES, name: "memes", kind: "channel", parent: null, newest: NOW - 3 * HOUR, canSend: false, enabled: false },
];

export const inbox: InboxItem[] = [
  { id: "i1", server: houseoverwatch.id, target: GENERAL, sender: "Sam", channel: GENERAL, sourceIds: ["m1"], summary: "Asked when the server backup runs next.", created_at: NOW - HOUR, done_at: null },
  { id: "i2", server: houseoverwatch.id, target: BUILD_THREAD, sender: "Ari with a very long display name that keeps going past the edge of the list", channel: BUILD_THREAD, sourceIds: ["m5"], summary: "Asked why the build is red on main. The answer is a flaky test in the payments package, which is skipped on the release branch until someone fixes its clock. Ari wants the summary in the thread too, with the link to the failing run and the name of whoever owns the test.", created_at: NOW - 26 * HOUR, done_at: null },
  { id: "i3", server: houseoverwatch.id, target: GENERAL, sender: "Sam", channel: GENERAL, sourceIds: ["m7"], summary: "Asked for the house rules again.", created_at: NOW - 3 * 24 * HOUR, done_at: NOW - 2 * HOUR },
];

/** A channel's saved transcript: a question, the reply that used it, and two other messages. */
export const transcript = (channel: string): TranscriptPage => ({
  channel: { id: channel, name: channel === GENERAL ? "general" : "channel", parent: null },
  canSend: channel === GENERAL,
  canShare: true,
  streamId: 1,
  hasMore: false,
  messages: [
    { id: "m1", channel, author: SAM, authorName: "Sam", username: "sam", avatarUrl: null, text: "Is the server backup still running at night?", timestamp: NOW - 3 * HOUR, editedAt: null, slopbot: false, runIds: [], used: false },
    { id: "m2", channel, author: session.user, authorName: "DerpZ", username: "derpz", avatarUrl: null, text: "Yes, at 03:00 UTC. @Slopbot can you check the last one?", timestamp: NOW - 2.9 * HOUR, editedAt: NOW - 2.8 * HOUR, slopbot: false, runIds: ["r1"], used: true },
    { id: "m3", channel, author: BOT, authorName: "Slopbot", username: null, avatarUrl: null, text: "The last backup finished at 03:04 UTC on Friday. It took 2 GB and no errors were logged.", timestamp: NOW - 2.8 * HOUR, editedAt: null, slopbot: true, runIds: ["r1"], used: false, turn: "m2" },
    { id: "m4", channel, author: ARI, authorName: "Ari", username: null, avatarUrl: null, text: "thanks", timestamp: NOW - HOUR, editedAt: null, slopbot: false, runIds: [], used: false },
  ],
});

/** The conversations of a channel: one per run. */
export const runs: ConversationSummary[] = [
  { id: "r1", title: "Last backup", author: session.user, authorName: "DerpZ", start: NOW - 3 * HOUR, end: NOW - 2.8 * HOUR, messageCount: 2 },
  { id: "r2", title: "A very long conversation title that does not fit in the panel, so it wraps to two lines and then is cut", author: SAM, authorName: "Sam", start: NOW - 2 * 24 * HOUR, end: NOW - 2 * 24 * HOUR + HOUR, messageCount: 1 },
];

export const usage: Usage = {
  plan: "Pro",
  windows: [
    { kind: "5h", percent: 42, resetAt: NOW + 2 * HOUR + 15 * 60_000, banked: 0 },
    { kind: "week", percent: 18, resetAt: NOW + 3 * 24 * HOUR + 4 * HOUR, banked: 1 },
  ],
};

/** A frozen share of a two-person chat: a question, and the answer with a tool row, an image and a file. */
export const shareData: ShareData = {
  id: "s1aaaaaaaaaaaaaaaaaa",
  messages: [
    { author: "DerpZ", bot: false, at: NOW - HOUR, text: "Why is my Postgres slow?", tools: [], thinking: "", images: [], files: [], other: 0 },
    { author: "Slopbot", bot: true, at: NOW - HOUR + 40_000, text: "Usually a missing index. Run `EXPLAIN ANALYZE` on the slowest query.", tools: [{ name: "explain_query", status: "completed" }], thinking: "", images: [{ src: "/api/shares/s1aaaaaaaaaaaaaaaaaa/images/1", name: "plan.png" }], files: [{ name: "orders.sql", size: 2048 }], other: 0 },
  ],
};
