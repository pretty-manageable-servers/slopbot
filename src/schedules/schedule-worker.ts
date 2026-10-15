import { FREE_PLAN_SCHEDULE_DAYS, MAX_FAILURES, SCHEDULE_KIND, SCHEDULE_RETRY_MS, SCHEDULE_TICK_MS, scheduleDeliveryId, scheduleMessageId, type Schedule } from "./schedule-types.js";
import { nextRun } from "./schedule-time.js";
import type { Json, Message } from "../domain.js";
import { errorSummary, logError, ToolError } from "../errors.js";
import type { AppRecord, RecordStore } from "../records.js";

// Discord errors that do not change on retry: Unknown Channel, Missing Access, Missing Permissions.
const permanentDiscordCodes = new Set([10003, 50001, 50013]);

function isPermanentDiscordError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" && permanentDiscordCodes.has(code);
}

/**
 * Side effects of ScheduleWorker. All are injected, so tests use fakes.
 * - server: the server to scan. Schedules are app_records of kind SCHEDULE_KIND.
 * - store: the record store. Writes use the revision CAS, as in ReminderWorker.
 * - authorize(message, channel): resolves when the owner may act in channel. A ToolError here
 *   (channel disabled, no permission) or a permanent Discord error pauses the schedule with "permission".
 * - reply(channel, text, deliveryId): posts text. deliveryId is deterministic, so a retried post can be deduped.
 * - enqueuePrompt(message): queues an agent turn as if the owner sent message.
 * - invokeTool(name, input, ctx): runs one tool without the model. Resolves to the text to post, or undefined
 *   to post nothing. ctx.id is the run's scheduleMessageId, used as the operation id.
 * - overGrace({server, user}): true when user is over the usage limit.
 * - now(): the current time.
 */
export interface ScheduleWorkerDeps {
  server: string;
  store: RecordStore;
  authorize(message: Message, channel: string): Promise<void>;
  reply(channel: string, text: string, deliveryId: string): Promise<void>;
  enqueuePrompt(message: Message): Promise<void>;
  invokeTool(
    name: string,
    input: Record<string, Json>,
    ctx: { id: string; author: string; channel: string; source: "command" },
  ): Promise<string | undefined>;
  overGrace(who: { server: string; user: string }): Promise<boolean>;
  now(): Date;
}

type Stage = "check" | "authorize" | "run";

const iso = (ms: number) => new Date(ms).toISOString();

// Copy without the fields that belong to one run. A new run sets them again.
function withoutRun(schedule: Schedule): Schedule {
  const copy: Schedule = { ...schedule };
  delete copy.retryAt;
  delete copy.lastError;
  delete copy.pauseReason;
  return copy;
}

export class ScheduleWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  constructor(private readonly deps: ScheduleWorkerDeps) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (!this.active)
        this.active = this.tick()
          .catch(error => logError("schedule_scan_failed", error, { stage: "schedule scan", server: this.deps.server }))
          .finally(() => {
            this.active = undefined;
          });
    };
    tick();
    this.timer = setInterval(tick, SCHEDULE_TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  async tick(): Promise<void> {
    for (const record of await this.deps.store.records(this.deps.server, SCHEDULE_KIND)) {
      try {
        await this.process(record);
      } catch (error) {
        logError("schedule_failed", error, { stage: "schedule", server: this.deps.server, operationId: record.id });
      }
    }
  }

  private async process(record: AppRecord): Promise<void> {
    const schedule = record.value as unknown as Schedule;
    const now = this.deps.now();
    const nowMs = now.getTime();
    if (schedule.status === "active" && schedule.expiresAt && Date.parse(schedule.expiresAt) <= nowMs) {
      await this.expire(record, schedule);
      return;
    }
    if (
      !["active", "running"].includes(schedule.status) ||
      schedule.nextAt === null ||
      Date.parse(schedule.nextAt) > nowMs ||
      (schedule.retryAt !== undefined && Date.parse(schedule.retryAt) > nowMs)
    )
      return;
    // Lease: "running" with retryAt in the future means another run holds it. A "running" record past its retryAt
    // was left by a crash, so it is taken again. The slot is still nextAt, so the delivery id is the same.
    const slot = schedule.nextAt;
    const leased: Schedule = { ...schedule, status: "running", retryAt: iso(nowMs + SCHEDULE_RETRY_MS) };
    if (!(await this.write(record.id, leased, record.revision))) return;
    await this.run(record.id, leased, slot, now, record.revision + 1);
  }

  private async run(id: string, leased: Schedule, slot: string, now: Date, revision: number): Promise<void> {
    const { channel, owner, name, action } = leased;
    const message: Message = {
      server: this.deps.server,
      channel,
      author: owner,
      id: scheduleMessageId(id, slot),
      text: action.kind === "tool" ? action.tool : action.text,
      timestamp: now.getTime(),
    };
    const deliveryId = scheduleDeliveryId(id, slot);
    let stage: Stage = "check";
    try {
      if (action.kind !== "message" && (await this.deps.overGrace({ server: this.deps.server, user: owner }))) {
        await this.write(id, { ...withoutRun(leased), status: "paused", pauseReason: "usage" }, revision);
        await this.note(channel, `<@${owner}> Schedule **${name}** paused: you are over your usage limit.`, `schedule:${id}:${slot}:usage`);
        return;
      }
      stage = "authorize";
      await this.deps.authorize(message, channel);
      stage = "run";
      if (action.kind === "message") {
        await this.deps.reply(channel, `<@${owner}> ${action.text}`, deliveryId);
      } else if (action.kind === "prompt") {
        await this.deps.enqueuePrompt({ ...message, addressed: true });
      } else {
        const output = await this.deps.invokeTool(action.tool, action.input, { id: message.id, author: owner, channel, source: "command" });
        if (output !== undefined) await this.deps.reply(channel, output, deliveryId);
      }
    } catch (error) {
      await this.failed(id, leased, slot, error, stage, revision, now);
      return;
    }
    const next = nextRun(leased.when, now);
    const done: Schedule = {
      ...withoutRun(leased),
      status: next ? "active" : "done",
      nextAt: next ? iso(next.getTime()) : null,
      failures: 0,
      lastRunAt: iso(now.getTime()),
    };
    if (!(await this.write(id, done, revision)))
      logError("schedule_state_conflict", new Error("Schedule changed during its run"), { stage: "schedule", server: this.deps.server, channel, operationId: id });
  }

  private async failed(id: string, leased: Schedule, slot: string, error: unknown, stage: Stage, revision: number, now: Date): Promise<void> {
    const { channel, name } = leased;
    const context = { stage: "schedule", server: this.deps.server, channel, operationId: id };
    const summary = errorSummary(error);
    const base = withoutRun(leased);
    if (isPermanentDiscordError(error) || (stage === "authorize" && error instanceof ToolError)) {
      logError("schedule_paused", error, context);
      await this.write(id, { ...base, status: "paused", pauseReason: "permission", lastError: summary }, revision);
      return;
    }
    logError("schedule_failed", error, context);
    const failures = leased.failures + 1;
    if (failures >= MAX_FAILURES) {
      await this.write(id, { ...base, status: "paused", pauseReason: "failures", failures, lastError: summary }, revision);
      await this.note(channel, `Schedule **${name}** paused after ${MAX_FAILURES} failed runs in a row.`, `schedule:${id}:${slot}:failures`);
      return;
    }
    await this.write(id, { ...base, status: "active", failures, lastError: summary, retryAt: iso(now.getTime() + SCHEDULE_RETRY_MS) }, revision);
  }

  private async expire(record: AppRecord, schedule: Schedule): Promise<void> {
    if (!(await this.write(record.id, { ...withoutRun(schedule), status: "expired", nextAt: null }, record.revision))) return;
    await this.note(
      schedule.channel,
      `Schedule **${schedule.name}** expired (free plan: ${FREE_PLAN_SCHEDULE_DAYS} days). Renew it with the schedule tool.`,
      `schedule:${record.id}:expired`,
    );
  }

  // A note that fails to post must not undo the state change that caused it.
  private async note(channel: string, text: string, deliveryId: string): Promise<void> {
    try {
      await this.deps.reply(channel, text, deliveryId);
    } catch (error) {
      logError("schedule_note_failed", error, { stage: "schedule", server: this.deps.server, channel });
    }
  }

  private write(id: string, value: Schedule, expectedRevision: number): Promise<boolean> {
    return this.deps.store.putRecord(this.deps.server, SCHEDULE_KIND, id, value as unknown as Json, expectedRevision);
  }
}
