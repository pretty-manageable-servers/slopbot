import type { Json, Message } from "./domain.js";
import type { RecordStore } from "./records.js";
import type { TimingSnapshot } from "./request-timing.js";
import { nestedTiming } from "./request-timing.js";
import { requestTimings } from "./request-timing.js";
import type { ToolActivity } from "./tool-activity.js";
import { ToolError, type ToolRegistry } from "./tools.js";

interface SavedTiming extends TimingSnapshot {
  channel: string;
  requestId: string;
  savedAt: number;
  delivery: "sent" | "failed";
  calls: readonly ToolActivity[];
}
const key = (channel: string, id: string) => JSON.stringify([channel, id]);
export async function saveRequestTiming(
  store: RecordStore,
  message: Message,
  timing: TimingSnapshot,
  delivery: "sent" | "failed",
  outputs: readonly Message[],
  calls: readonly ToolActivity[],
): Promise<void> {
  const id = key(message.channel, message.id);
  const old = await store.record(message.server, "request_timing", id);
  // Delivery recovery must not replace a complete original measurement with a partial replay.
  if ((old?.value as unknown as SavedTiming | undefined)?.delivery !== "sent") {
    const value: SavedTiming = {
      ...timing,
      channel: message.channel,
      requestId: message.id,
      savedAt: Date.now(),
      delivery,
      calls,
    };
    await store.putRecord(
      message.server,
      "request_timing",
      id,
      value as unknown as Json,
      old?.revision ?? 0,
    );
  }
  for (const output of outputs) {
    if (output.server !== message.server || output.channel !== message.channel)
      continue;
    await store.putRecord(
      message.server,
      "request_timing_link",
      key(output.channel, output.id),
      id,
      0,
    );
  }
}
const stageDescription = (name: string): string =>
  name.endsWith(" journal")
    ? "event batch writes; included within parent stage"
    : ({
        references: "fetch referenced Discord messages",
        participation: "decision-model classification",
        "participation queue":
          "wait behind earlier channel checks; within participation",
        "decision classifier":
          "actual classifier, including setup and journaling; within participation",
        "participation context": "history for the decision model",
        queue: "wait for a worker",
        context: "assemble history, profiles, retrieval and checkpoints",
        model: "model streaming and event journaling",
        "checkpoint model": "checkpoint summarization; included within context",
        delivery:
          "formatting, delivery journal, Discord API and status cleanup",
      }[name] ??
      (name.startsWith("tool:")
        ? "tool executor, including authorization and resource wait"
        : "measured stage"));

export function registerTimingTools(
  registry: ToolRegistry,
  services: {
    store: RecordStore;
    authorize(message: Message, channel: string): Promise<void>;
  },
): void {
  registry.register({
    name: "timing_active",
    description:
      "Show live request stages and awaited operations in the current permitted channel. Snapshot only; concurrent waits are not proof of root cause. No message contents or tool arguments.",
    fields: {},
    access: "member",
    effect: "read",
    retrySafe: true,
    async authorize(context) {
      await services.authorize(context.message, context.message.channel);
      const cached = await registry.recordedResult(context.operationId);
      if (
        cached?.sources?.some(
          (source) =>
            source.kind === "message" &&
            (source.server !== context.message.server ||
              source.channel !== context.message.channel),
        )
      )
        throw new ToolError(
          "Timing is restricted to its original permitted channel.",
        );
    },
    async execute(context) {
      const active = requestTimings
        .active(context.message.server, context.message.channel)
        .filter((item) => item.requestId !== context.message.id)
        .slice(0, 8);
      if (!active.length)
        return { text: "No other active request is recorded in this channel." };
      return {
        text: [
          "**Live request waits**",
          ...active.map(
            (item) =>
              `- Request \`${item.requestId}\` | elapsed ${(item.timing.totalMs / 1000).toFixed(1)}s\n  Stages: ${(item.timing.activeStages ?? []).join(", ") || "none"}\n  Awaiting: ${(item.timing.activeWaits ?? []).map((wait) => `\`${wait.name}\` ${(wait.elapsedMs / 1000).toFixed(1)}s`).join(" | ") || "application/uninstrumented"}`,
          ),
          "Snapshot of client awaits; provider internals and CPU causes are not observable. This inspection runs through the normal worker queue.",
        ].join("\n"),
        sources: active.map((item) => ({
          kind: "message" as const,
          server: context.message.server,
          channel: context.message.channel,
          id: item.requestId,
        })),
      };
    },
  });
  registry.register({
    name: "timing_inspect",
    description:
      "Explain measured timing for a completed request or bot response. Prefer omitting message_id to inspect the replied-to response. Do not target the incoming request: its timing is not saved until delivery. Measurements do not prove root cause.",
    fields: {
      view: {
        type: "string",
        description: "summary or pageable detailed timeline",
        choices: ["summary", "timeline"],
      },
      offset: {
        type: "integer",
        description: "Timeline offset, default 0",
        min: 0,
        max: 256,
      },
      message_id: {
        type: "string",
        description:
          "Request or response message ID in this channel; defaults to reply target",
        max: 100,
      },
    },
    access: "member",
    effect: "read",
    retrySafe: true,
    async authorize(context) {
      await services.authorize(context.message, context.message.channel);
      const cached = await registry.recordedResult(context.operationId);
      if (
        cached?.sources?.some(
          (source) =>
            source.kind === "message" &&
            (source.server !== context.message.server ||
              source.channel !== context.message.channel),
        )
      ) {
        throw new ToolError(
          "Timing is restricted to its original permitted channel.",
        );
      }
    },
    async execute(context, args) {
      const message = context.message;
      const requested = String(args.message_id ?? message.replyTo ?? "");
      if (!requested)
        throw new ToolError(
          "Reply to a request or bot response, or provide message_id.",
        );
      let id = key(message.channel, requested);
      const link = await services.store.record(
        message.server,
        "request_timing_link",
        id,
      );
      if (typeof link?.value === "string") id = link.value;
      const saved = await services.store.record(
        message.server,
        "request_timing",
        id,
      );
      if (!saved)
        return {
          text: "No recorded timing for this message in the current channel. Older requests from before timing storage was added are unavailable.",
        };
      const value = saved.value as unknown as SavedTiming;
      if (value.channel !== message.channel)
        throw new ToolError("Timing is restricted to this permitted channel.");
      const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
      if (args.view === "timeline") {
        if (!value.timeline)
          return {
            text: "Legacy record: detailed timeline was not collected.",
          };
        const offset = Number(args.offset ?? 0),
          intervals = value.timeline.slice(offset, offset + 10);
        return {
          text: [
            `**Await timeline** | retained intervals ${offset + 1}–${offset + intervals.length} of ${value.timeline.length}`,
            ...intervals.map(
              (item) =>
                `- ${seconds(item.startMs)} to ${seconds(item.endMs)} | ${item.waits.map((name) => `\`${name}\``).join(" + ") || "application/uninstrumented"}${item.stages?.length ? ` | stages: ${item.stages.join(", ")}` : ""}`,
            ),
            ...(offset + 10 < value.timeline.length
              ? [`More: view=timeline, offset=${offset + 10}`]
              : []),
            value.timelineTruncated
              ? "Older detail was truncated; wait totals are retained."
              : "Joined labels are concurrent awaits; these intervals do not overlap.",
          ].join("\n"),
          sources: [
            {
              kind: "message",
              server: message.server,
              channel: message.channel,
              id: value.requestId,
            },
          ],
        };
      }
      const steps = Object.entries(value.steps).sort((a, b) => b[1] - a[1]);
      const measured = steps
        .filter(([name]) => !nestedTiming(name))
        .reduce((sum, [, ms]) => sum + ms, 0);
      const lines = [
        `**Request timing**`,
        `Total: **${seconds(value.totalMs)}**, including delivery | ${value.delivery}${value.partial ? " | partial measurement" : ""}`,
        "**Stage durations (can overlap)**",
        ...steps
          .slice(0, 6)
          .map(
            ([name, ms]) =>
              `- \`${name}\`: ${seconds(ms)} | ${stageDescription(name)}`,
          ),
        ...(!value.blockedMs ? [`- Other/uninstrumented: ${seconds(Math.max(0, value.totalMs - measured))}`] : []),
      ];
      if (value.blockedMs) {
        const displayedWaits = Object.entries(value.blockedMs).sort((a,b)=>b[1]-a[1]).slice(0,6);
        lines.push(
          "**Largest wall-clock waits**",
          ...displayedWaits
            .map(([name, ms]) => `- \`${name}\`: ${seconds(ms)}`),
          `- Remaining intervals: ${seconds(Math.max(0,value.totalMs-displayedWaits.reduce((sum,[,ms])=>sum+ms,0)))}`,
          "Non-overlapping intervals; joined labels are concurrent awaits. Uninstrumented is a coverage gap. Use view=timeline for detail.",
        );
        if (value.timelineTruncated)
          lines.push(
            "Detailed timeline is bounded/truncated; aggregate wait accounting remains available.",
          );
      } else
        lines.push(
          "Legacy record: detailed wait accounting was not collected.",
        );
      if (value.firstOutputMs.length)
        lines.push(
          `First model output per call: ${value.firstOutputMs.map(seconds).join(", ")} (within model time; may be reasoning/tool output).`,
        );
      if (value.calls.length)
        lines.push(
          `**Individual tool calls${value.calls.length > 6 ? " (first 6)" : ""}**`,
          ...value.calls
            .slice(0, 6)
            .map(
              (call, index) =>
                `${index + 1}. \`${call.name}\` | ${call.status} | ${call.reused ? "saved result; original duration unavailable" : call.durationMs === undefined ? "duration unavailable" : seconds(call.durationMs)}`,
            ),
        );
      lines.push(
        "Journal times overlap parent stages; classifier/queue are within participation; checkpoint overlaps context. Generation continues after first output. Measurements cannot isolate GPU computation. Other includes unmeasured work/backoff.",
      );
      return {
        text: lines.join("\n"),
        sources: [
          {
            kind: "message",
            server: message.server,
            channel: message.channel,
            id: value.requestId,
          },
        ],
      };
    },
  });
}
