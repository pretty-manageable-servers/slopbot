import { errorSummary, logError } from "../errors.js";
import type { Json, Message } from "../domain.js";
import type { RecordStore } from "../records.js";
import { ToolError, type ToolRegistry } from "../tools.js";
import { uiKey } from "../ui/runtime.js";
export interface Reminder {
  channel: string;
  owner: string;
  text: string;
  at: number;
  status: "scheduled" | "sending" | "sent" | "cancelled" | "failed";
  retryAt?: number;
  error?: string;
}
export function registerReminderTools(
  registry: ToolRegistry,
  services: {
    store: RecordStore;
    authorize(message: Message, channel: string): Promise<void>;
    /** The text channel a reminder from this request posts in. Undefined keeps the request channel. */
    reminderChannel?: (message: Message) => string | undefined;
  },
  now = Date.now,
): void {
  registry.register({
    name: "reminder", surface: "top",
    description:
      "Schedule a personal reminder in this channel, list your reminders, or cancel one. Use an ISO timestamp with explicit timezone; ask for clarification when time is ambiguous.",
    fields: {
      action: {
        type: "string",
        description: "Operation",
        choices: ["create", "list", "cancel"],
        required: true,
      },
      text: { type: "string", description: "Reminder text", max: 1500 },
      at: {
        type: "string",
        description: "ISO timestamp with Z or timezone offset",
      },
      id: { type: "string", description: "Reminder reference to cancel" },
    },
    access: "member",
    effect: "write",
    retrySafe: true,
    execution: "inline",
    authorize: (context) =>
      services.authorize(context.message, context.message.channel),
    writes: (args) => args.action !== "list",
    resource: (message) => `reminders:${message.server}:${message.author}`,
    async execute(context, args) {
      await services.authorize(context.message, context.message.channel);
      // A voice request uses the join channel, the same as create. Other requests use their own channel.
      const channel = services.reminderChannel?.(context.message) ?? context.message.channel;
      if (channel !== context.message.channel) await services.authorize(context.message, channel);
      if (args.action === "list") {
        const records = (
          await services.store.records(context.message.server, "reminder")
        ).filter((record) => {
          const reminder = record.value as unknown as Reminder;
          return (
            reminder.owner === context.message.author &&
            reminder.channel === channel
          );
        });
        return (
          records
            .map((record) => {
              const reminder = record.value as unknown as Reminder;
              return `${reminder.text} — ${new Date(reminder.at).toISOString()} (${reminder.status}${reminder.error ? `; ${reminder.error}` : ""})\nReference: ${record.id}`;
            })
            .join("\n\n") || "No reminders in this channel."
        );
      }
      if (args.action === "cancel") {
        const record = await services.store.record(
          context.message.server,
          "reminder",
          String(args.id ?? ""),
        );
        if (!record) throw new ToolError("Reminder not found.");
        const reminder = record.value as unknown as Reminder;
        if (reminder.owner !== context.message.author)
          throw new ToolError("Only the reminder owner can cancel it.");
        if (reminder.channel !== channel)
          throw new ToolError("Use the reminder’s original channel.");
        if (reminder.status === "failed")
          throw new ToolError(`Reminder already failed: ${reminder.error ?? "unknown error"}.`);
        if (reminder.status === "sending" || reminder.status === "sent")
          throw new ToolError("Reminder delivery has already started.");
        if (
          !(await services.store.putRecord(
            context.message.server,
            "reminder",
            record.id,
            { ...reminder, status: "cancelled" } as unknown as Json,
            record.revision,
          ))
        )
          throw new ToolError("Reminder changed; retry.");
        return "Reminder cancelled.";
      }
      const timestamp = String(args.at ?? "");
      const at = Date.parse(timestamp);
      if (
        !/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ||
        !Number.isFinite(at) ||
        at <= now() ||
        at > now() + 366 * 86400000
      )
        throw new ToolError(
          "Use a future ISO timestamp with timezone, within one year.",
        );
      if (!String(args.text ?? "").trim())
        throw new ToolError("Reminder text is required.");
      const id = uiKey(context.operationId);
      const reminder: Reminder = {
        channel,
        owner: context.message.author,
        text: String(args.text),
        at,
        status: "scheduled",
      };
      await services.store.putRecord(
        context.message.server,
        "reminder",
        id,
        reminder as unknown as Json,
        0,
      );
      return {
        text: `Reminder scheduled for ${new Date(at).toISOString()}.\nReference: ${id}`,
        ui: {
          version: 1,
          type: "card",
          title: "Reminder",
          text: `${reminder.text}\n${new Date(at).toISOString()}`,
          actions: [
            { label: "Cancel", action: "reminder.cancel", arguments: { id } },
          ],
        },
      };
    },
  });
}
// Discord errors that do not change on retry: Unknown Channel, Missing Access, Missing Permissions.
const permanentDiscordCodes = new Set([10003, 50001, 50013]);

// Read the numeric code from the original error. DiscordAPIError has it as `code`.
function isPermanentDiscordError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" && permanentDiscordCodes.has(code);
}

export class ReminderWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  constructor(
    private readonly server: string,
    private readonly store: RecordStore,
    private readonly deliver: (
      message: Message,
      text: string,
      deliveryId: string,
    ) => Promise<void>,
    private readonly authorize: (
      message: Message,
      channel: string,
    ) => Promise<void>,
    private readonly now = Date.now,
  ) {}
  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (!this.active)
        this.active = this.tick()
          .catch(error => logError("reminder_scan_failed", error, { stage: "reminder scan", server: this.server }))
          .finally(() => {
            this.active = undefined;
          });
    };
    tick();
    this.timer = setInterval(tick, 15000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
  // Stop retrying. Keep the record with status "failed" so the owner can see why.
  private async markFailed(id: string, reminder: Reminder, error: unknown, revision: number): Promise<void> {
    const context = { stage: "reminder", server: this.server, channel: reminder.channel, operationId: id, final: true };
    logError("reminder_failed", error, context);
    await this.store.putRecord(
      this.server,
      "reminder",
      id,
      {
        ...reminder,
        status: "failed",
        retryAt: 0,
        error: errorSummary(error),
      } as unknown as Json,
      revision,
    );
  }

  async tick(): Promise<void> {
    for (const record of await this.store.records(this.server, "reminder")) {
      const reminder = record.value as unknown as Reminder;
      if (
        !["scheduled", "sending"].includes(reminder.status) ||
        reminder.at > this.now() ||
        (reminder.retryAt ?? 0) > this.now()
      )
        continue;
      const message: Message = {
        server: this.server,
        channel: reminder.channel,
        author: reminder.owner,
        id: `command:reminder:${record.id}`,
        text: reminder.text,
        timestamp: this.now(),
      };
      try {
        await this.authorize(message, reminder.channel);
      } catch (error) {
        if (isPermanentDiscordError(error)) {
          await this.markFailed(record.id, reminder, error, record.revision);
          continue;
        }
        logError("reminder_failed", error, { stage: "reminder", server: this.server, channel: reminder.channel, operationId: record.id });
        await this.store.putRecord(
          this.server,
          "reminder",
          record.id,
          {
            ...reminder,
            retryAt: this.now() + 60000,
            error: errorSummary(error),
          } as unknown as Json,
          record.revision,
        );
        continue;
      }
      // A lease prevents overlapping schedulers; deterministic delivery IDs reconcile a crash after sending.
      if (
        !(await this.store.putRecord(
          this.server,
          "reminder",
          record.id,
          {
            ...reminder,
            status: "sending",
            retryAt: this.now() + 60000,
          } as unknown as Json,
          record.revision,
        ))
      )
        continue;
      try {
        await this.deliver(
          message,
          `<@${reminder.owner}> Reminder: ${reminder.text}`,
          `reminder:${record.id}`,
        );
        await this.store.putRecord(
          this.server,
          "reminder",
          record.id,
          { ...reminder, status: "sent", retryAt: 0 } as unknown as Json,
          record.revision + 1,
        );
      } catch (error) {
        if (isPermanentDiscordError(error)) {
          await this.markFailed(record.id, reminder, error, record.revision + 1);
          continue;
        }
        logError("reminder_failed", error, { stage: "reminder", server: this.server, channel: reminder.channel, operationId: record.id });
        await this.store.putRecord(
          this.server,
          "reminder",
          record.id,
          {
            ...reminder,
            status: "sending",
            retryAt: this.now() + 60000,
            error: errorSummary(error),
          } as unknown as Json,
          record.revision + 1,
        );
      }
    }
  }
}
