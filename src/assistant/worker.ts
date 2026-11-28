import type { Message } from "../domain.js";
import { errorSummary, logError } from "../errors.js";
import { nextRun } from "../schedules/schedule-time.js";
import { PERSONAL_SERVER } from "../personal.js";
import type { AssistantStore } from "./store.js";
import {
  ASSISTANT_TICK_MS,
  MAX_TASK_FAILURES,
  assistantHomeChannel,
  assistantTaskChannel,
  type ActivityKind,
  type AssistantLimits,
  type AssistantSettings,
  type AssistantTask,
  type Trigger,
  type TriggerKind,
} from "./types.js";
import { wakePrompt, zonedClock, type WakeTarget } from "./wake-prompt.js";

/** Due tasks, due briefs and owners handled per tick. */
const MAX_DUE_PER_TICK = 10;
/** A wake moves nextAt this far ahead before it submits. A crash then leaves the task due again later, not at once. */
const WAKE_CLAIM_MS = 10 * 60_000;
const MINUTE_MS = 60_000;

/**
 * Side effects of AssistantWorker. All are injected, so tests use fakes.
 * - submit(message): queues one agent turn as the owner. The personal workspace's submit.
 * - overUsage(user): true when user is over the usage limit (the same check as ScheduleWorker's overGrace).
 * - triggerOwners(): the owners that may have untaken triggers.
 * - now(): the current time in ms. Defaults to Date.now.
 */
export interface AssistantWorkerDeps {
  store: AssistantStore;
  submit(message: Message): Promise<void>;
  limits(): Promise<AssistantLimits>;
  overUsage(user: string): Promise<boolean>;
  triggerOwners(): Promise<string[]>;
  now?: () => number;
}

function minuteOf(hhmm: string | null): number | null {
  const match = hhmm === null ? null : /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const [hours, minutes] = [+match[1]!, +match[2]!];
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** When the quiet hours that cover `now` end, or null when `now` is not in quiet hours. The range may wrap past midnight. */
function quietEnd(now: number, settings: AssistantSettings): number | null {
  const start = minuteOf(settings.quietStart);
  const end = minuteOf(settings.quietEnd);
  if (start === null || end === null || start === end) return null;
  const { minute } = zonedClock(now, settings.timezone);
  const quiet = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!quiet) return null;
  return now - (now % MINUTE_MS) + ((end - minute + 1440) % 1440) * MINUTE_MS;
}

function nextCron(cron: string, timezone: string, now: number): number | null {
  return nextRun({ kind: "cron", cron, timezone }, new Date(now))?.getTime() ?? null;
}

/** The trigger kind a wake reports. An approval wins; a timer wake has no triggers. */
function wakeKind(triggers: readonly Trigger[]): TriggerKind {
  return triggers.find(trigger => trigger.kind === "approval")?.kind ?? triggers[0]?.kind ?? "timer";
}

/**
 * Wakes the assistant's sprouts, daily briefs and home thread. Several workers may run: a wake moves nextAt
 * with a revision CAS before it submits, so only one worker wins a due task.
 */
export class AssistantWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private readonly now: () => number;
  constructor(private readonly deps: AssistantWorkerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (!this.active)
        this.active = this.tick()
          .catch(error => logError("assistant_tick_failed", error, { stage: "assistant tick" }))
          .finally(() => {
            this.active = undefined;
          });
    };
    tick();
    this.timer = setInterval(tick, ASSISTANT_TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  async tick(): Promise<void> {
    const { store } = this.deps;
    const now = this.now();
    const limits = await this.deps.limits();
    const tasks = await store.dueTasks(now, MAX_DUE_PER_TICK);
    const briefs = await store.dueBriefs(now, MAX_DUE_PER_TICK);
    const owners = new Set([...tasks.map(task => task.owner), ...briefs.map(brief => brief.user), ...(await this.deps.triggerOwners())]);
    for (const owner of owners) {
      try {
        await this.wakeOwner(owner, tasks.filter(task => task.owner === owner), briefs.some(brief => brief.user === owner), now, limits);
      } catch (error) {
        logError("assistant_wake_failed", error, { stage: "assistant wake", operationId: owner });
      }
    }
  }

  private async wakeOwner(owner: string, tasks: AssistantTask[], briefDue: boolean, now: number, limits: AssistantLimits): Promise<void> {
    const { store } = this.deps;
    const settings = await store.settings(owner);
    if (!settings?.enabled) return;
    const triggers = await store.takeTriggers(owner, now);
    const byTask = new Map<string, Trigger[]>();
    const home: Trigger[] = [];
    for (const trigger of triggers) {
      if (trigger.task === null) home.push(trigger);
      else byTask.set(trigger.task, [...(byTask.get(trigger.task) ?? []), trigger]);
    }
    const due = new Map(tasks.map(task => [task.id, task]));
    for (const id of new Set([...due.keys(), ...byTask.keys()])) {
      const task = due.get(id) ?? (await store.task(id));
      // A trigger for a task that is gone or belongs to someone else is dropped.
      if (!task || task.owner !== owner) continue;
      try {
        await this.wakeTask(task, byTask.get(id) ?? [], settings, limits, now);
      } catch (error) {
        logError("assistant_wake_failed", error, { stage: "assistant wake", operationId: id });
      }
    }
    if (briefDue || home.length) await this.wakeHome(settings, home, briefDue, now);
  }

  private async wakeTask(task: AssistantTask, triggers: Trigger[], settings: AssistantSettings, limits: AssistantLimits, now: number): Promise<void> {
    const { store } = this.deps;
    // A trigger that reaches a paused or finished task is dropped.
    if (task.status !== "active") return;
    // Over usage the sprout stays active and is retried after the minimum wake interval, so it restarts once the window resets.
    if (await this.deps.overUsage(task.owner)) {
      const held: AssistantTask = { ...task, pause: "usage", nextAt: now + limits.minWakeMinutes * MINUTE_MS, updatedAt: now };
      if ((await this.save(held, task.revision)) && task.pause !== "usage")
        await this.activity(task.owner, task.id, "paused", "Paused: over your usage limit. Bud tries again later.", now);
      return;
    }
    // Quiet hours hold timer wakes only. Triggers are never held.
    const held = triggers.length === 0 ? quietEnd(now, settings) : null;
    if (held !== null) {
      await this.save({ ...task, nextAt: held, updatedAt: now }, task.revision);
      return;
    }
    const resumed = task.pause === "usage";
    const claimed: AssistantTask = { ...task, pause: resumed ? null : task.pause, nextAt: now + WAKE_CLAIM_MS, updatedAt: now };
    if (!(await this.save(claimed, task.revision))) {
      // Another worker claimed the task first. The triggers go back on the queue for the next tick.
      for (const trigger of triggers) await store.addTrigger({ ...trigger, id: `${trigger.id}:requeue:${now}`, takenAt: null });
      return;
    }
    if (resumed) await this.activity(task.owner, task.id, "update", "Resumed after your usage limit reset.", now);
    const expected = task.revision + 1;
    const slot = triggers.length === 0 ? (task.nextAt ?? now) : now;
    const target: WakeTarget = { kind: "task", goal: task.goal, instructions: task.instructions, timezone: settings.timezone };
    const message = this.message(task.owner, assistantTaskChannel(task.id), `assistant:${task.id}:${slot}`, task.id, wakeKind(triggers), wakePrompt(target, triggers, now), now);
    try {
      await this.deps.submit(message);
    } catch (error) {
      await this.failed(claimed, expected, error, now);
      return;
    }
    const nextAt = this.nextWake(task, limits, now);
    const done: AssistantTask = { ...claimed, status: nextAt === null ? "done" : "active", nextAt, lastRunAt: now, failures: 0, lastError: null };
    if (!(await this.save(done, expected))) logError("assistant_state_conflict", new Error("Task changed during its wake"), { stage: "assistant wake", operationId: task.id });
  }

  private async failed(claimed: AssistantTask, expected: number, error: unknown, now: number): Promise<void> {
    logError("assistant_wake_failed", error, { stage: "assistant wake", operationId: claimed.id });
    const failures = claimed.failures + 1;
    const lastError = errorSummary(error);
    // Below the limit nextAt keeps the claim, so the task retries after WAKE_CLAIM_MS.
    if (failures < MAX_TASK_FAILURES) {
      await this.save({ ...claimed, failures, lastError }, expected);
      return;
    }
    if (await this.save({ ...claimed, status: "paused", pause: "failures", failures, lastError }, expected))
      await this.activity(claimed.owner, claimed.id, "paused", `Paused after ${MAX_TASK_FAILURES} failed wakes: ${lastError}`, now);
  }

  /** The home thread: the daily brief, or the messages that triggers left. */
  private async wakeHome(settings: AssistantSettings, home: Trigger[], briefDue: boolean, now: number): Promise<void> {
    const { store } = this.deps;
    const owner = settings.user;
    const briefCron = briefDue ? settings.briefCron : null;
    // The brief is a timer wake, so quiet hours hold it unless triggers came with it.
    const held = briefCron !== null && home.length === 0 ? quietEnd(now, settings) : null;
    if (held !== null) {
      await store.setBriefNextAt(owner, held);
      return;
    }
    const nextBrief = briefCron === null ? null : nextCron(briefCron, settings.timezone, now);
    if (await this.deps.overUsage(owner)) {
      if (briefCron !== null) {
        await store.setBriefNextAt(owner, nextBrief);
        await this.activity(owner, null, "paused", "Daily brief skipped: you are over your usage limit.", now);
      }
      return;
    }
    // Claim the brief before the submit, so the next tick does not see it as due.
    if (briefCron !== null) await store.setBriefNextAt(owner, now + WAKE_CLAIM_MS);
    const target: WakeTarget = { kind: briefCron !== null ? "brief" : "home", timezone: settings.timezone };
    const message = this.message(owner, assistantHomeChannel(owner), `assistant:home:${now}`, null, wakeKind(home), wakePrompt(target, home, now), now);
    try {
      await this.deps.submit(message);
    } catch (error) {
      logError("assistant_wake_failed", error, { stage: "assistant wake", operationId: owner });
    }
    // A brief that failed to submit is skipped, not retried. It waits for its next cron time.
    if (briefCron !== null) await store.setBriefNextAt(owner, nextBrief);
  }

  private nextWake(task: AssistantTask, limits: AssistantLimits, now: number): number | null {
    const { wake } = task;
    return wake.kind === "interval" ? now + Math.max(wake.minutes, limits.minWakeMinutes) * MINUTE_MS : nextCron(wake.cron, wake.timezone, now);
  }

  private message(owner: string, channel: string, id: string, task: string | null, trigger: TriggerKind, text: string, now: number): Message {
    return { id, server: PERSONAL_SERVER, channel, author: owner, text, surface: "web", timestamp: now, assistant: { owner, task, trigger } };
  }

  /** Writes a task with a revision CAS. The stored revision is expected + 1. */
  private save(task: AssistantTask, expected: number): Promise<boolean> {
    return this.deps.store.putTask({ ...task, revision: expected + 1 }, expected);
  }

  private async activity(owner: string, task: string | null, kind: ActivityKind, text: string, now: number): Promise<void> {
    await this.deps.store.addActivity({ id: `${kind}:${task ?? "home"}:${now}`, owner, task, kind, text, ref: null, createdAt: now, readAt: null });
  }
}
