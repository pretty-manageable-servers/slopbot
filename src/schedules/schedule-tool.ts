import type { Json, Message } from "../domain.js";
import type { AppRecord, RecordStore } from "../records.js";
import { ToolError, type ToolRegistry, type ToolResult } from "../tools.js";
import { stableJson } from "../prompt-cache.js";
import { uiKey } from "../ui/runtime.js";
import { GLOBAL_SETTINGS_SCOPE } from "../usage-cost.js";
import { nextRun, scheduleLimits, validateWhen } from "./schedule-time.js";
import {
  FREE_PLAN_SCHEDULE_DAYS,
  MAX_SCHEDULE_NAME,
  MAX_SCHEDULE_TEXT,
  SCHEDULE_KIND,
  SCHEDULE_LIMITS_KEY,
  type Schedule,
  type ScheduleAction,
  type ScheduleStatus,
  type ScheduleWhen,
} from "./schedule-types.js";

/**
 * Services the schedule tool needs. Nothing more.
 * - store: read and write schedule records (RecordStore), and read the limits setting (setting).
 * - authorize: the channel check for each call (authorizeFeature in discord.ts).
 * - isTeamEditor: a team editor sees every schedule and can change any of them.
 */
export interface ScheduleToolServices {
  store: RecordStore & { setting(server: string, key: string): unknown };
  authorize(message: Message, channel: string): Promise<void>;
  isTeamEditor(user: string): boolean | Promise<boolean>;
}

const DAY_MS = 86_400_000;
/** Tools a scheduled run may not call. A schedule must not create more schedules or reminders. */
const reservedTools: ReadonlySet<string> = new Set(["schedule", "reminder"]);
/** Statuses that count toward the caps. */
const liveStatuses: ReadonlySet<ScheduleStatus> = new Set(["active", "running", "paused"]);

const iso = (ms: number) => new Date(ms).toISOString();
const objectOf = (value: Json | undefined): Record<string, Json> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const scheduleOf = (record: AppRecord) => record.value as unknown as Schedule;

function parseWhen(value: Json | undefined): ScheduleWhen {
  const raw = objectOf(value);
  if (raw?.kind === "once" && typeof raw.at === "string") return { kind: "once", at: raw.at };
  if (raw?.kind === "cron" && typeof raw.cron === "string" && typeof raw.timezone === "string")
    return { kind: "cron", cron: raw.cron, timezone: raw.timezone };
  throw new ToolError('Use when as {"kind":"once","at":"<ISO time with Z or offset>"} or {"kind":"cron","cron":"<5 fields>","timezone":"<IANA zone>"}.');
}

async function parseRun(registry: ToolRegistry, message: Message, value: Json | undefined): Promise<ScheduleAction> {
  const raw = objectOf(value);
  const kind = raw?.kind;
  if (kind === "message" || kind === "prompt") {
    const text = typeof raw?.text === "string" ? raw.text.trim() : "";
    if (!text) throw new ToolError("The run needs text.");
    if (text.length > MAX_SCHEDULE_TEXT) throw new ToolError(`The run text can be at most ${MAX_SCHEDULE_TEXT} characters.`);
    return { kind, text };
  }
  if (kind === "tool") {
    const tool = typeof raw?.tool === "string" ? raw.tool : "";
    if (!tool) throw new ToolError("The tool run needs a tool name.");
    if (reservedTools.has(tool)) throw new ToolError(`A scheduled run cannot call ${tool}.`);
    // Checks the tool exists and its input matches the tool's fields. Throws for unknown tools.
    const input = registry.validate(tool, raw?.input ?? {});
    // The owner is the requester on create, so this checks the owner's access now. The run checks it again.
    await registry.checkAccess(message, tool);
    return { kind: "tool", tool, input };
  }
  throw new ToolError('Use run as {"kind":"message","text":"..."}, {"kind":"prompt","text":"..."} or {"kind":"tool","tool":"<name>","input":{}}.');
}

function describe(schedule: Schedule): string {
  const when = schedule.when.kind === "once" ? `once at ${schedule.when.at}` : `${schedule.when.cron} ${schedule.when.timezone}`;
  const state = schedule.pauseReason ? `${schedule.status}, ${schedule.pauseReason}` : schedule.status;
  return `${schedule.name} — ${when} — next ${schedule.nextAt ?? "none"} — expires ${schedule.expiresAt ?? "never"} — ${state}\nReference: ${schedule.id}`;
}

function createdResult(schedule: Schedule): ToolResult {
  return {
    text: `Schedule "${schedule.name}" created. Next run: ${schedule.nextAt ?? "none"}.\nReference: ${schedule.id}`,
    ui: {
      version: 1,
      type: "card",
      title: "Schedule",
      text: `${schedule.name}\nNext run: ${schedule.nextAt ?? "none"}${schedule.expiresAt ? `\nExpires: ${schedule.expiresAt}` : ""}`,
      actions: [
        { label: "Pause", action: "schedule.pause", arguments: { id: schedule.id } },
        { label: "Cancel", action: "schedule.cancel", arguments: { id: schedule.id } },
      ],
    },
  };
}

function createId(message: Message, name: string, when: ScheduleWhen, run: ScheduleAction): string {
  return uiKey(stableJson(["schedule", message.server, message.channel, message.author, message.id, name, when, run]));
}

export function registerScheduleTool(registry: ToolRegistry, services: ScheduleToolServices, now = Date.now): void {
  const { store } = services;

  const load = async (server: string, id: string): Promise<AppRecord> => {
    const record = await store.record(server, SCHEDULE_KIND, id);
    if (!record) throw new ToolError("Schedule not found.");
    return record;
  };

  // Only the owner or a team editor may change a schedule.
  const mayChange = async (message: Message, schedule: Schedule): Promise<void> => {
    if (schedule.owner === message.author) return;
    if (await services.isTeamEditor(message.author)) return;
    throw new ToolError("Only the schedule owner or a Slopbot team member can change it.");
  };

  // Compare-and-set write. A changed record means another write won, so the caller retries.
  const save = async (server: string, record: AppRecord, next: Schedule): Promise<void> => {
    if (!(await store.putRecord(server, SCHEDULE_KIND, record.id, next as unknown as Json, record.revision)))
      throw new ToolError("Schedule changed; retry.");
  };

  registry.register({
    name: "schedule", surface: "top",
    description:
      "Create, list, pause, resume, renew or cancel scheduled work in this channel. A schedule runs once, or on a cron schedule with an IANA timezone. A run posts text, sends a prompt as the owner, or runs one saved tool call without the model. Recurring schedules expire after 30 days unless renewed.",
    fields: {
      action: {
        type: "string",
        description: "Operation",
        choices: ["create", "list", "pause", "resume", "renew", "cancel"],
        required: true,
      },
      name: { type: "string", description: "Short label, for create", max: MAX_SCHEDULE_NAME },
      when: {
        type: "json",
        description:
          'For create: {"kind":"once","at":"ISO time with Z or offset"} or {"kind":"cron","cron":"0 9 * * 1","timezone":"Europe/London"}',
      },
      run: {
        type: "json",
        description:
          'For create: {"kind":"message","text":"..."}, {"kind":"prompt","text":"..."} or {"kind":"tool","tool":"<name>","input":{}}',
      },
      id: { type: "string", description: "Schedule reference, for pause, resume, renew or cancel" },
    },
    access: "member",
    effect: "write",
    retrySafe: true,
    reconcileBlocking: true,
    async reconcile(context, args) {
      if (args.action !== "create") return undefined;
      const when = parseWhen(args.when);
      const run = await parseRun(registry, context.message, args.run);
      const id = createId(context.message, String(args.name ?? "").trim(), when, run);
      const record = await store.record(context.message.server, SCHEDULE_KIND, id);
      return record ? createdResult(scheduleOf(record)) : undefined;
    },
    execution: "inline",
    writes: (args) => args.action !== "list",
    resource: (message) => `schedules:${message.server}`,
    authorize: (context) => services.authorize(context.message, context.message.channel),
    async execute(context, args): Promise<string | ToolResult> {
      const { message } = context;
      const action = String(args.action);
      const current = now();

      if (action === "list") {
        const team = await services.isTeamEditor(message.author);
        const rows = (await store.records(message.server, SCHEDULE_KIND))
          .map(scheduleOf)
          .filter((schedule) => team || schedule.owner === message.author);
        return rows.map(describe).join("\n\n") || "No schedules in this server.";
      }

      if (action === "create") {
        const name = String(args.name ?? "").trim();
        if (!name) throw new ToolError("Schedule name is required.");
        const when = parseWhen(args.when);
        const run = await parseRun(registry, message, args.run);
        // A program retry has a new operation ID but still belongs to the same request.
        // Include the payload so one request can intentionally create distinct schedules.
        const id = createId(message, name, when, run);
        const existing = await store.record(message.server, SCHEDULE_KIND, id);
        if (existing) return createdResult(scheduleOf(existing));
        // Limits are read after parsing so a bad request is reported before any cap message.
        const limits = scheduleLimits(store.setting(GLOBAL_SETTINGS_SCOPE, SCHEDULE_LIMITS_KEY) as Json | undefined);
        validateWhen(when, run.kind, limits, new Date(current));

        const live = (await store.records(message.server, SCHEDULE_KIND)).map(scheduleOf).filter((schedule) => liveStatuses.has(schedule.status));
        if (live.length >= limits.perServer) throw new ToolError(`This server has reached its schedule limit (${limits.perServer}).`);
        if (live.filter((schedule) => schedule.owner === message.author).length >= limits.perUser)
          throw new ToolError(`You have reached your schedule limit (${limits.perUser}).`);

        const next = nextRun(when, new Date(current));
        const schedule: Schedule = {
          id,
          server: message.server,
          channel: message.channel,
          owner: message.author,
          name,
          when,
          action: run,
          status: "active",
          nextAt: next ? iso(next.getTime()) : null,
          expiresAt: when.kind === "cron" ? iso(current + FREE_PLAN_SCHEDULE_DAYS * DAY_MS) : null,
          failures: 0,
          createdAt: iso(current),
          requestId: message.id,
        };
        await context.assertActive();
        if (!(await store.putRecord(message.server, SCHEDULE_KIND, id, schedule as unknown as Json, 0)))
          return createdResult(scheduleOf(await load(message.server, id)));
        return createdResult(schedule);
      }

      // pause, resume, renew and cancel all act on one existing schedule.
      const record = await load(message.server, String(args.id ?? ""));
      const schedule = scheduleOf(record);
      await mayChange(message, schedule);

      if (action === "pause") {
        if (schedule.status !== "active") throw new ToolError("Only an active schedule can be paused.");
        await save(message.server, record, { ...schedule, status: "paused", pauseReason: "owner", nextAt: null });
        return `Schedule "${schedule.name}" paused.`;
      }

      if (action === "resume") {
        if (schedule.status !== "paused") throw new ToolError("Only a paused schedule can be resumed.");
        if (schedule.expiresAt && Date.parse(schedule.expiresAt) <= current) throw new ToolError("This schedule has expired. Renew it first.");
        const next = nextRun(schedule.when, new Date(current));
        if (!next) throw new ToolError("This schedule has no future run. Cancel it instead.");
        const resumed: Schedule = { ...schedule, status: "active", nextAt: iso(next.getTime()), failures: 0 };
        delete resumed.pauseReason;
        await save(message.server, record, resumed);
        return `Schedule "${schedule.name}" resumed. Next run: ${resumed.nextAt}.`;
      }

      if (action === "renew") {
        if (schedule.when.kind !== "cron") throw new ToolError("Only recurring schedules expire. There is nothing to renew.");
        if (!["active", "paused", "expired"].includes(schedule.status)) throw new ToolError(`This schedule is ${schedule.status}; it cannot be renewed.`);
        const renewed: Schedule = { ...schedule, expiresAt: iso(current + FREE_PLAN_SCHEDULE_DAYS * DAY_MS), renewedAt: iso(current) };
        if (schedule.status === "expired") {
          // An expired schedule has no run time left. Compute the next one from now.
          const next = nextRun(schedule.when, new Date(current));
          renewed.status = "active";
          renewed.nextAt = next ? iso(next.getTime()) : null;
        }
        await save(message.server, record, renewed);
        return `Schedule "${schedule.name}" renewed. Expires: ${renewed.expiresAt}.`;
      }

      // cancel
      if (schedule.status === "cancelled" || schedule.status === "done") throw new ToolError(`This schedule is already ${schedule.status}.`);
      if (schedule.status === "running") throw new ToolError("This schedule is running; try again shortly.");
      const cancelled: Schedule = { ...schedule, status: "cancelled", nextAt: null };
      delete cancelled.pauseReason;
      await save(message.server, record, cancelled);
      return `Schedule "${schedule.name}" cancelled.`;
    },
  });
}
