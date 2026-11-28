// Fake bot data for Storybook and `pnpm dev:mock`: one user, DerpZ, in two servers, with a few chats. Handlers
// (handlers.ts) serve it; stories that need other data override one handler with `parameters.msw.handlers`.
import type { EngineEnvelope, EngineEvent, MemoryItem, ShareData } from "@slopbot/contracts";
import type { BotMessage } from "../events";
import type {
  AdminMe, ChatShare, ChatSummary, Conversation, ConversationSummary, InboxItem, Project, ProjectDetail, ProjectFile, ProjectLimits, ProjectList,
  ProjectMemoryView, ProjectSummary, ServerShare, ServerSnapshot, ServerSummary, Session, Status, TranscriptPage, Usage,
  ActivityItem, ApprovalRequest, AssistantConnector, AssistantSettings, AssistantState, AssistantTask,
} from "../api-types";

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

// Projects. The limits are the bot's defaults; `projectLimits` is what the list and the upload checks read.
const MB_BYTES = 1024 * 1024;
export const projectLimits: ProjectLimits = { maxProjects: 5, maxFiles: 20, maxFileBytes: 10 * MB_BYTES, maxProjectBytes: 25 * MB_BYTES };
export const projectSummaries: ProjectSummary[] = [
  { id: "p1", name: "Thesis", description: "Notes and drafts for the stats thesis. Keep answers in British English.", updated: NOW - 2 * HOUR, fileCount: 3 },
  { id: "p2", name: "Garden", description: "", updated: NOW - 9 * HOUR, fileCount: 0 },
];
export const projectList: ProjectList = { projects: projectSummaries, limits: projectLimits };
const projectOne: Project = {
  id: "p1", owner: "u1", name: "Thesis", description: "Notes and drafts for the stats thesis. Keep answers in British English.",
  instructions: "Answer in British English. Use short paragraphs.", instructionsUpdated: NOW - 3 * HOUR, created: NOW - 5 * HOUR * 24, updated: NOW - 2 * HOUR,
};
export const projectFiles: ProjectFile[] = [
  { id: "f1", project: "p1", name: "chapter-2.md", contentType: "text/markdown", size: 48_000, created: NOW - 2 * HOUR },
  { id: "f2", project: "p1", name: "survey.csv", contentType: "text/csv", size: 1.4 * MB_BYTES, created: NOW - 4 * HOUR },
  { id: "f3", project: "p1", name: "supervisor-notes.pdf", contentType: "application/pdf", size: 220_000, created: NOW - 24 * HOUR },
];
export const projectDetail: ProjectDetail = {
  project: projectOne,
  files: projectFiles,
  chats: [{ id: "c1", title: "Why is my Postgres slow", updated: NOW - HOUR, effort: "medium", project: "p1" }],
  usedBytes: 1.7 * MB_BYTES,
};
export const projectMemories: ProjectMemoryView[] = [
  { id: "m1", content: "The user writes in British English and prefers short paragraphs.", category: "style", updatedAt: NOW - 6 * HOUR },
  { id: "m2", content: "The survey has 412 respondents; the response rate is 61 percent.", category: "facts", updatedAt: NOW - 30 * HOUR },
];

export const memoryItems: MemoryItem[] = [
  { id: "mem1", content: "Alice likes green tea.", category: "preference", tags: [], scope: "personal", updated: NOW - 2 * HOUR },
  { id: "mem2", content: "The survey has 412 respondents; the response rate is 61 percent.", category: "fact", tags: [], scope: "project:p1", updated: NOW - 30 * HOUR },
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

/** The same chat, but the question comes with a picture and a file. */
export const chatWithAttachments: BotMessage[] = chatSaved.map((m) => (!m.slopbot
  ? { ...m, images: [{ imageId: "img1", name: "query-plan.png", contentType: "image/png", size: 48_213 }], files: [{ fileId: "file1", name: "orders-indexes.sql", contentType: "application/sql", size: 2048 }] }
  : m));

/** A picture for the attachments of stories, served for any image URL: a plain card. */
export const sampleImage = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#3d5a80"/><rect x="24" y="24" width="272" height="24" rx="4" fill="#98c1d9"/><rect x="24" y="64" width="180" height="16" rx="4" fill="#e0fbfc"/></svg>';

/** The share link of chat c1: active, with newer messages to add. */
export const chatShares: ChatShare[] = [
  { id: "cs1aaaaaaaaaaaaaaaaa", created_at: NOW - 24 * HOUR, revoked: false, frozen_at: NOW - 23 * HOUR, newer: true },
];

/** A long channel: `count` messages from three people, as one page with older ones to load. */
export const longTranscript = (channel: string, count = 200): TranscriptPage => {
  const people = [["Sam", SAM], ["Ari", ARI], ["DerpZ", session.user]] as const;
  return {
    channel: { id: channel, name: "general", parent: null },
    canSend: true,
    canShare: true,
    streamId: 1,
    hasMore: true,
    messages: Array.from({ length: count }, (_, i) => {
      const [authorName, author] = people[i % people.length]!;
      return { id: `l${i}`, channel, author, authorName, username: null, avatarUrl: null, text: `Message ${i + 1} of the very long thread. ${"The cron job still runs at 03:00 UTC. ".repeat(1 + (i % 3))}`, timestamp: NOW - (count - i) * 60_000, editedAt: null, slopbot: false, runIds: [], used: false };
    }),
  };
};

/** A live reply in a channel: Sam asks Slopbot something and the answer streams in (no thinking row: the kit draws it with an h3 that fails the heading-order check). */
export const channelLive = (channel: string): EngineEvent[] => chatLive.filter((event) => event.type !== "thinking.delta").map((event) => (event.type === "message.upsert"
  ? { ...event, message: { ...event.message, channel, author: SAM, authorName: "Sam", text: "@Slopbot can you check the orders table too?" } }
  : event));

// Bud, the assistant: on, with two proposed sprouts, an active one, one paused by failures, two approvals waiting and
// an activity feed of 24 items (the feed pages 20 at a time). `unread` counts the first two items.
const MINUTE = 60_000;
const sprout = (over: Pick<AssistantTask, "id" | "goal" | "status"> & Partial<AssistantTask>): AssistantTask => ({
  owner: session.user, instructions: "", pause: null, wake: { kind: "interval", minutes: 360 }, nextAt: null, rules: {}, effort: "medium",
  failures: 0, lastRunAt: null, lastError: null, createdAt: NOW - 24 * HOUR, updatedAt: NOW - HOUR, revision: 1, ...over,
});
export const assistantSettings: AssistantSettings = {
  user: session.user, enabled: true, briefCron: "0 8 * * *", timezone: "Europe/Berlin", dmUpdates: true, quietStart: "22:00", quietEnd: "07:00", updated: NOW,
};
export const assistantTasks: AssistantTask[] = [
  sprout({ id: "t-proposed-1", goal: "Summarise the Postgres release notes every week", status: "proposed", wake: { kind: "cron", cron: "0 9 * * 1", timezone: "Europe/Berlin" } }),
  sprout({ id: "t-proposed-2", goal: "Keep the garden watering log up to date", status: "proposed", instructions: "Note the rain each morning." }),
  sprout({ id: "t-active", goal: "Watch the build dashboard for failures", status: "active", wake: { kind: "interval", minutes: 60 }, nextAt: NOW + 30 * MINUTE, lastRunAt: NOW - 30 * MINUTE, effort: "low", rules: { github_comment: "ask", web_search: "allow" }, instructions: "Report failures on main only." }),
  sprout({ id: "t-paused", goal: "Track the Tailscale ACL changes", status: "paused", pause: "failures", failures: 3, lastError: "The ACL feed returned 503.", rules: { web_search: "allow" }, revision: 4 }),
];
export const assistantApprovals: ApprovalRequest[] = [
  { id: "a-1", owner: session.user, task: "t-active", run: "run-1", tool: "github_comment", input: { issue: 42 }, summary: "Comment on issue #42: main has been red since 09:10.", status: "pending", result: null, createdAt: NOW - 20 * MINUTE, decidedAt: null, expiresAt: NOW + 7 * 24 * HOUR },
  { id: "a-2", owner: session.user, task: null, run: "run-2", tool: "send_email", input: {}, summary: "Send the weekly brief to the team list.", status: "pending", result: null, createdAt: NOW - 2 * HOUR, decidedAt: null, expiresAt: NOW + 6 * 24 * HOUR },
];
const activityTexts: [ActivityItem["kind"], string][] = [
  ["approval", "Asked to comment on issue #42."],
  ["update", "Build dashboard: two failures on main, reported."],
  ["paused", "Paused \"Track the Tailscale ACL changes\" after three failures."],
  ["brief", "Morning brief: three items for today."],
];
export const assistantActivity: ActivityItem[] = Array.from({ length: 24 }, (_, i) => {
  const [kind, text] = activityTexts[i % activityTexts.length]!;
  return {
    id: `act-${i + 1}`, owner: session.user, task: i % 2 ? "t-active" : null, kind, text, ref: null,
    createdAt: NOW - (i + 1) * 45 * MINUTE, readAt: i < 2 ? null : NOW - HOUR,
  };
});
export const assistantConnectors: AssistantConnector[] = [{ name: "github", url: "https://mcp.example.com/github" }];
export const assistantState = (): AssistantState => ({
  settings: assistantSettings, tasks: assistantTasks, pending: assistantApprovals, unread: assistantActivity.filter((item) => item.readAt === null).length,
  homeChat: `assistant:${session.user}`,
});
