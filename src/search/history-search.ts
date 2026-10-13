import { createHash } from "node:crypto";
import type { Json, Message } from "../domain.js";
import { ToolError, type ToolRegistry, type ToolResult } from "../tools.js";

export interface HistoryQuery {
  server: string;
  channel: string;
  query: string;
  mode: "hybrid" | "keyword" | "exact" | "semantic";
  excludeId?: string;
  author?: string;
  after?: number | undefined;
  before?: number | undefined;
  limit: number;
  offset?: number;
}
export interface HistoryPage {
  messages: Message[];
  nextOffset?: number | undefined;
  degraded: boolean;
  candidateLimit: number;
  coverage: {
    messages: number;
    vectors: number;
    oldest: number | null;
    newest: number | null;
  };
}
export interface HistorySearch {
  searchHistory(query: HistoryQuery): Promise<HistoryPage>;
  readHistory(
    server: string,
    channel: string,
    id: string,
    radius: number,
  ): Promise<Message[]>;
}
export interface SearchServices {
  store: HistorySearch & {
    findPeople(
      server: string,
      query: string,
    ): Promise<{ id: string; name: string }[]> | { id: string; name: string }[];
    setting(server: string, key: string): unknown;
    setSetting(server: string, key: string, value: Json): Promise<void> | void;
  };
  authorize(message: Message, channel: string): Promise<void>;
}
export const messageLink = (message: Message) =>
  `https://discord.com/channels/${message.server}/${message.channel}/${message.id}`;
const authorLabel = (message: Message) =>
  message.authorName && !/^\d{17,20}$/.test(message.authorName)
    ? message.authorName
    : "Unknown member";
export function historyResult(messages: readonly Message[]): ToolResult {
  return {
    text: messages.length
      ? messages
          .map(
            (message) =>
              `${authorLabel(message)} · ${message.timestamp ? new Date(message.timestamp).toISOString() : "date unknown"}\n${message.text.slice(0, 3000)}${message.text.length > 3000 ? " [excerpt]" : ""}\n${messageLink(message)}`,
          )
          .join("\n\n")
      : "No indexed messages found.",
    sources: messages.map((message) => ({
      kind: "message",
      server: message.server,
      channel: message.channel,
      id: message.id,
    })),
  };
}
function date(value: Json | undefined): number | undefined {
  if (value === undefined) return;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp))
    throw new ToolError("Use an ISO date or timestamp.");
  return timestamp;
}
export function registerHistoryTools(
  registry: ToolRegistry,
  services: SearchServices,
): void {
  registry.register({
    name: "history_search",
    description:
      "Search indexed messages. Hybrid combines keywords and semantic similarity. Exact finds literal quotes. Resolve authors by name or mention. Refine queries and use history_read for context; no result is not proof something was never said.",
    fields: {
      query: { type: "string", description: "Topic or quote", max: 1000 },
      mode: {
        type: "string",
        description: "Default hybrid",
        choices: ["hybrid", "keyword", "exact", "semantic"],
      },
      author: { type: "string", description: "Member name or mention" },
      channel: { type: "channel", description: "Defaults to current channel" },
      after: { type: "string", description: "ISO start date" },
      before: { type: "string", description: "ISO end date" },
      limit: {
        type: "integer",
        description: "Results per page, default 10",
        min: 1,
        max: 10,
      },
      cursor: {
        type: "string",
        description: "Opaque next-page cursor from previous search",
      },
    },
    access: "member",
    effect: "read",
    retrySafe: true,
    async authorize(context, args) {
      let channel = String(args.channel ?? context.message.channel);
      if (args.cursor) {
        const saved = services.store.setting(
          context.message.server,
          `search:${String(args.cursor)}`,
        ) as
          | { actor: string; expires: number; query: HistoryQuery }
          | undefined;
        if (
          !saved ||
          saved.actor !== context.message.author ||
          saved.expires < Date.now() ||
          saved.query.server !== context.message.server
        )
          throw new ToolError(
            "Search cursor expired or belongs to another member. Start a new search.",
          );
        channel = saved.query.channel;
      }
      await services.authorize(context.message, channel);
    },
    async execute(context, args) {
      let query: HistoryQuery;
      if (args.cursor) {
        const saved = services.store.setting(
          context.message.server,
          `search:${String(args.cursor)}`,
        ) as
          | { actor: string; expires: number; query: HistoryQuery }
          | undefined;
        if (
          !saved ||
          saved.actor !== context.message.author ||
          saved.expires < Date.now()
        )
          throw new ToolError(
            "Search cursor expired or belongs to another member. Start a new search.",
          );
        query = { ...saved.query };
      } else {
        let author: string | undefined;
        if (args.author) {
          const people = await services.store.findPeople(
            context.message.server,
            String(args.author),
          );
          if (people.length !== 1)
            throw new ToolError(
              people.length
                ? "That name is ambiguous; use a mention."
                : "Member not found; use their Discord mention.",
            );
          author = people[0]!.id;
        }
        query = {
          server: context.message.server,
          channel: String(args.channel ?? context.message.channel),
          query: String(args.query ?? ""),
          mode: (args.mode ?? "hybrid") as HistoryQuery["mode"],
          limit: Number(args.limit ?? 10),
          ...(author ? { author } : {}),
          ...(args.after ? { after: date(args.after) } : {}),
          before: args.before ? date(args.before) : Date.now(),
        };
        if (
          query.after !== undefined &&
          query.before !== undefined &&
          query.after > query.before
        )
          throw new ToolError("Start date must precede end date.");
      }
      await services.authorize(context.message, query.channel);
      const page = await services.store.searchHistory(query);
      const result = historyResult(page.messages);
      let cursor: string | undefined;
      if (page.nextOffset !== undefined) {
        cursor = createHash("sha256")
          .update(context.operationId + ":next")
          .digest("hex")
          .slice(0, 32);
        await services.store.setSetting(query.server, `search:${cursor}`, {
          actor: context.message.author,
          expires: Date.now() + 3600000,
          query: { ...query, offset: page.nextOffset },
        } as unknown as Json);
      }
      result.text += `\n\nCoverage: ${page.coverage.messages} messages, ${page.coverage.vectors} vectors; ${page.coverage.oldest ? new Date(page.coverage.oldest).toISOString() : "unknown"} to ${page.coverage.newest ? new Date(page.coverage.newest).toISOString() : "unknown"}. Ranked candidate cap: ${page.candidateLimit}.${page.degraded ? " Semantic search unavailable; keyword fallback used." : ""}${cursor ? ` Next cursor: ${cursor}` : ""}`;
      return result;
    },
  });
  registry.register({
    name: "history_read",
    description:
      "Read an indexed message with nearby chronological messages and its reply ancestors.",
    fields: {
      id: {
        type: "string",
        description: "Message ID from search",
        required: true,
      },
      channel: { type: "channel", description: "Defaults to current channel" },
      radius: {
        type: "integer",
        description: "Nearby messages on each side, default 3",
        min: 0,
        max: 10,
      },
    },
    access: "member",
    effect: "read",
    retrySafe: true,
    authorize: (context, args) =>
      services.authorize(
        context.message,
        String(args.channel ?? context.message.channel),
      ),
    async execute(context, args) {
      const channel = String(args.channel ?? context.message.channel);
      await services.authorize(context.message, channel);
      return historyResult(
        await services.store.readHistory(
          context.message.server,
          channel,
          String(args.id),
          Number(args.radius ?? 3),
        ),
      );
    },
  });
}
