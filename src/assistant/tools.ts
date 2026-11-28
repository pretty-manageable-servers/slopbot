import { randomUUID } from "node:crypto";
import { EFFORTS, type Effort, type Json, type Message } from "../domain.js";
import { nextRun } from "../schedules/schedule-time.js";
import { ToolError, type ToolRegistry } from "../tools.js";
import type { AssistantStore } from "./store.js";
import {
  assistantHomeChannel,
  assistantTaskChannel,
  assistantTaskMemoryChannel,
  isAssistantChannel,
  MAX_GOAL_CHARS,
  MAX_NOTIFY_CHARS,
  type ActivityItem,
  type AssistantLimits,
  type AssistantTask,
  type Notifier,
  type RuleEffect,
  type Wake,
} from "./types.js";

export interface AssistantToolDeps {
  store: AssistantStore;
  notifier: Notifier;
  limits(): Promise<AssistantLimits>;
  memory: { remember(user: string, channel: string, text: string): Promise<void> };
  chats: { ensure(channel: string, owner: string, title: string): Promise<void> };
  now?: () => number;
  id?: () => string;
}

const RULE_EFFECTS: readonly RuleEffect[] = ["allow", "ask", "block"];

/** The assistant tag of the message, or a refusal for a message that is not an assistant wake. */
function assistantRun(message: Message) {
  if (!message.assistant) throw new ToolError("Bud tools run only in an assistant wake.");
  return message.assistant;
}

function parseWake(value: Json | undefined): Wake {
  const wake = value as { kind?: unknown; minutes?: unknown; cron?: unknown; timezone?: unknown } | null | undefined;
  if (wake?.kind === "interval" && typeof wake.minutes === "number" && Number.isInteger(wake.minutes) && wake.minutes > 0) return { kind: "interval", minutes: wake.minutes };
  if (wake?.kind === "cron" && typeof wake.cron === "string" && typeof wake.timezone === "string") return { kind: "cron", cron: wake.cron, timezone: wake.timezone };
  throw new ToolError('Wake is {"kind":"interval","minutes":n} or {"kind":"cron","cron":"…","timezone":"…"}.');
}

function parseRules(value: Json | undefined): Record<string, RuleEffect> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolError("Rules map a tool name to allow, ask or block.");
  for (const effect of Object.values(value)) if (!RULE_EFFECTS.includes(effect as RuleEffect)) throw new ToolError("Rules map a tool name to allow, ask or block.");
  return value as Record<string, RuleEffect>;
}

/** Bud's tools are offered only in assistant chats. */
const offered = (message: Message) => isAssistantChannel(message.channel);

/** Throws when a cron wake fires more often than minutes apart, from its next two runs after `at`. */
function checkCronWake(wake: Extract<Wake, { kind: "cron" }>, minutes: number, at: number): void {
  let first: Date | null, second: Date | null;
  try {
    first = nextRun(wake, new Date(at));
    second = first && nextRun(wake, first);
  } catch { throw new ToolError("The cron is not valid."); }
  if (!first || !second) throw new ToolError("The cron is not valid.");
  if (second.getTime() - first.getTime() < minutes * 60_000) throw new ToolError(`Sprouts wake at most every ${minutes} minutes.`);
}

/** Makes sure the Bud home chat row exists, so the normal chat view shows it. */
export function ensureHomeChat(chats: AssistantToolDeps["chats"], user: string): Promise<void> {
  return chats.ensure(assistantHomeChannel(user), user, "Bud");
}

export function registerAssistantTools(registry: ToolRegistry, deps: AssistantToolDeps): void {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.id ?? randomUUID;

  registry.register({
    name: "assistant_notify", offered,
    description: "Tell the owner what Bud did or found. feed adds it to the activity feed; dm also sends it as a direct message.",
    access: "member", effect: "write", retrySafe: false, execution: "inline",
    fields: {
      text: { type: "string", description: "What to tell the owner", required: true, max: MAX_NOTIFY_CHARS },
      level: { type: "string", description: "feed or dm", required: true, choices: ["feed", "dm"] },
    },
    async execute(context, args) {
      const run = assistantRun(context.message);
      const item: ActivityItem = { id: newId(), owner: run.owner, task: run.task, kind: "update", text: String(args.text), ref: null, createdAt: now(), readAt: null };
      await store.addActivity(item);
      if (args.level === "dm") await deps.notifier.notify(item);
      return "ok";
    },
  });

  registry.register({
    name: "assistant_idle", offered,
    description: "Nothing needs doing this wake. Ends the wake without a change.",
    access: "member", effect: "write", retrySafe: true, execution: "inline",
    fields: {},
    async execute(context) {
      assistantRun(context.message);
      return "ok";
    },
  });

  registry.register({
    name: "task_propose", offered,
    description: "Propose a sprout: a goal Bud works on at a set wake interval. Only from the Bud home thread. The owner accepts it before it wakes.",
    access: "member", effect: "write", retrySafe: false, execution: "inline",
    fields: {
      goal: { type: "string", description: "What the sprout is for", required: true, max: MAX_GOAL_CHARS },
      instructions: { type: "string", description: "How to pursue the goal", max: MAX_GOAL_CHARS },
      wake: { type: "json", description: 'When to wake: {"kind":"interval","minutes":n} or {"kind":"cron","cron":"…","timezone":"…"}', required: true },
      rules: { type: "json", description: "Tool name to allow, ask or block. Missing tools use the default effect." },
      effort: { type: "string", description: "Default: medium", choices: EFFORTS },
    },
    async execute(context, args) {
      const run = assistantRun(context.message);
      if (run.task !== null) throw new ToolError("Propose sprouts from the Bud home thread.");
      const limits = await deps.limits();
      const open = (await store.tasks(run.owner)).filter(task => task.status === "active" || task.status === "proposed").length;
      if (open >= limits.maxActiveTasks) throw new ToolError(`Limit reached: ${open} active sprouts.`);
      const wake = parseWake(args.wake);
      if (wake.kind === "interval" && wake.minutes < limits.minWakeMinutes) throw new ToolError(`Sprouts wake at most every ${limits.minWakeMinutes} minutes.`);
      if (wake.kind === "cron") checkCronWake(wake, limits.minWakeMinutes, now());
      const id = newId(), at = now(), goal = String(args.goal);
      const task: AssistantTask = {
        id, owner: run.owner, goal, instructions: String(args.instructions ?? ""), status: "proposed", pause: null,
        wake, nextAt: null, rules: parseRules(args.rules), effort: String(args.effort ?? "medium") as Effort,
        failures: 0, lastRunAt: null, lastError: null, createdAt: at, updatedAt: at, revision: 1,
      };
      if (!await store.putTask(task, null)) throw new ToolError("Could not save the sprout. Try again.");
      await deps.chats.ensure(assistantTaskChannel(id), run.owner, goal.slice(0, 60));
      await store.addActivity({ id: newId(), owner: run.owner, task: id, kind: "proposal", text: goal, ref: id, createdAt: at, readAt: null });
      return `Proposed sprout ${id}.`;
    },
  });

  registry.register({
    name: "task_note", offered,
    description: "Save a note to this sprout's own memory. Only in a sprout run.",
    access: "member", effect: "write", retrySafe: false, execution: "inline",
    fields: {
      text: { type: "string", description: "The note", required: true },
    },
    async execute(context, args) {
      const run = assistantRun(context.message);
      if (run.task === null) throw new ToolError("Notes belong to a sprout run.");
      await deps.memory.remember(run.owner, assistantTaskMemoryChannel(run.task), String(args.text));
      return "Noted.";
    },
  });

  registry.register({
    name: "task_finish", offered,
    description: "Finish this sprout. It does not wake again. Only in a sprout run.",
    access: "member", effect: "write", retrySafe: false, execution: "inline",
    fields: {
      summary: { type: "string", description: "What was done and what the owner should know", required: true },
    },
    async execute(context, args) {
      const run = assistantRun(context.message);
      if (run.task === null) throw new ToolError("Only a sprout run can finish.");
      const task = await store.task(run.task);
      if (!task) throw new ToolError("Unknown sprout.");
      const finished: AssistantTask = { ...task, status: "done", nextAt: null, updatedAt: now(), revision: task.revision + 1 };
      if (!await store.putTask(finished, task.revision)) throw new ToolError("The sprout changed while finishing. Try again.");
      await store.addActivity({ id: newId(), owner: run.owner, task: run.task, kind: "done", text: String(args.summary), ref: null, createdAt: finished.updatedAt, readAt: null });
      return "Sprout finished.";
    },
  });
}
