import type { Json, Message } from "../domain.js";
import type { RecordStore } from "../records.js";
import { ToolError, type ToolRegistry } from "../tools.js";
import { uiKey } from "../ui/runtime.js";
interface Task {
  channel: string;
  creator: string;
  owner: string;
  goal: string;
  progress: string;
  questions: string;
  status: "open" | "done";
  source: string;
}
export function registerTaskTools(
  registry: ToolRegistry,
  services: {
    store: RecordStore & {
      findPeople(
        server: string,
        query: string,
      ):
        | Promise<{ id: string; name: string }[]>
        | { id: string; name: string }[];
      profile(
        server: string,
        id: string,
      ): Promise<{ name: string }> | { name: string };
    };
    authorize(message: Message, channel: string): Promise<void>;
  },
): void {
  registry.register({
    name: "task_manage",
    description:
      "Track collaborative goals, owners, progress and outstanding questions. Separate from task_start, which starts agentic work. Changes require the creator, owner, or server administrator.",
    fields: {
      action: {
        type: "string",
        description: "Operation",
        choices: ["create", "list", "get", "update", "complete"],
        required: true,
      },
      id: { type: "string", description: "Task reference" },
      goal: { type: "string", description: "Goal", max: 1000 },
      owner: {
        type: "string",
        description: "Owner name or mention; default requester",
      },
      progress: {
        type: "string",
        description: "Progress or blockers",
        max: 1500,
      },
      questions: {
        type: "string",
        description: "Outstanding questions",
        max: 1500,
      },
    },
    access: "member",
    effect: "write",
    retrySafe: true,
    execution: "inline",
    authorize: (context) =>
      services.authorize(context.message, context.message.channel),
    writes: (args) => !["list", "get"].includes(String(args.action)),
    resource: (message) => `tracked-tasks:${message.server}:${message.channel}`,
    async execute(context, args) {
      await services.authorize(context.message, context.message.channel);
      if (args.action === "list") {
        const items = (
          await services.store.records(context.message.server, "task")
        ).filter(
          (record) =>
            (record.value as unknown as Task).channel ===
            context.message.channel,
        );
        const lines = await Promise.all(
          items.map(async (record) => {
            const task = record.value as unknown as Task;
            return `**${task.goal}** — ${task.status}; owner: ${(await services.store.profile(context.message.server, task.owner)).name}\n${task.progress}${task.questions ? `\nQuestions: ${task.questions}` : ""}\nReference: ${record.id}`;
          }),
        );
        return {
          text: lines.join("\n\n") || "No tracked tasks in this channel.",
          ui: {
            version: 1,
            type: "card",
            title: "Tasks",
            text: (lines.join("\n\n") || "No tracked tasks.").slice(0, 3500),
            actions: items
              .filter(
                (item) => (item.value as unknown as Task).status === "open",
              )
              .slice(0, 5)
              .map((item) => ({
                label: `Complete ${(item.value as unknown as Task).goal.slice(0, 60)}`,
                action: "task.complete",
                arguments: { id: item.id },
              })),
          },
        };
      }
      const id =
        args.action === "create"
          ? uiKey(context.operationId)
          : String(args.id ?? "");
      const record = await services.store.record(
        context.message.server,
        "task",
        id,
      );
      if (args.action === "create" && record)
        return `Task already created. Reference: ${id}`;
      if (args.action !== "create" && !record)
        throw new ToolError("Task not found.");
      let task: Task = record?.value as unknown as Task;
      if (task?.channel && task.channel !== context.message.channel)
        throw new ToolError("Use the task’s original channel.");
      if (args.action === "get")
        return {
          text: `${task.goal}: ${task.status}. Owner: ${(await services.store.profile(context.message.server, task.owner)).name}.\n${task.progress}\nQuestions: ${task.questions || "None"}\nReference: ${id}`,
        };
      if (
        task &&
        ![task.creator, task.owner].includes(context.message.author) &&
        !context.isAdmin
      )
        throw new ToolError(
          "Only the creator, owner, or administrator can change this task.",
        );
      let owner = task?.owner ?? context.message.author;
      if (args.owner) {
        const people = await services.store.findPeople(
          context.message.server,
          String(args.owner),
        );
        if (people.length !== 1)
          throw new ToolError(
            "Owner is unknown or ambiguous; use a Discord mention.",
          );
        owner = people[0]!.id;
      }
      if (args.action === "create" && !String(args.goal ?? "").trim())
        throw new ToolError("Creating a task requires a goal.");
      task = {
        channel: context.message.channel,
        creator: task?.creator ?? context.message.author,
        owner,
        goal: String(args.goal ?? task?.goal ?? ""),
        progress: String(args.progress ?? task?.progress ?? ""),
        questions: String(args.questions ?? task?.questions ?? ""),
        status: args.action === "complete" ? "done" : (task?.status ?? "open"),
        source: task?.source ?? context.message.id,
      };
      if (!task.goal.trim()) throw new ToolError("A task must have a goal.");
      if (
        !(await services.store.putRecord(
          context.message.server,
          "task",
          id,
          task as unknown as Json,
          record?.revision ?? 0,
        ))
      )
        throw new ToolError(
          "Task changed concurrently; read its current state and retry.",
        );
      return {
        text: `${task.goal}: ${task.status}. Owner: ${(await services.store.profile(context.message.server, owner)).name}.\nReference: ${id}`,
        ui: {
          version: 1,
          type: "card",
          title: task.goal.slice(0, 150),
          text: `Status: ${task.status}\n${task.progress}${task.questions ? `\nQuestions: ${task.questions}` : ""}`,
          ...(task.status === "open"
            ? {
                actions: [
                  {
                    label: "Complete",
                    action: "task.complete",
                    arguments: { id },
                  },
                ],
              }
            : {}),
        },
      };
    },
  });
}
