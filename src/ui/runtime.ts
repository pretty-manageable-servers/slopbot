import { errorSummary } from "../errors.js";
import { uiActions } from "./actions.js";
import { createHash } from "node:crypto";
import type { Json, Message } from "../domain.js";
import type { RecordStore } from "../records.js";
import { ToolError, type ToolRegistry, type ToolResult } from "../tools.js";
import { validateUi, type UiAction, type UiDocument } from "./schema.js";
export interface UiState {
  document: UiDocument;
  channel: string;
  owner: string;
  expires: number;
  pending?: boolean;
  pendingOperation?: string;
}
export const uiKey = (seed: string) =>
  createHash("sha256").update(seed).digest("hex").slice(0, 24);
export function actionArguments(action: UiAction): Record<string, Json> {
  return { ...action.arguments, ...uiActions[action.action]?.fixedArguments };
}
export class UiRuntime {
  constructor(
    private readonly store: RecordStore,
    private readonly tools: ToolRegistry,
    private readonly authorize: (
      message: Message,
      channel: string,
    ) => Promise<void>,
  ) {}
  async current(
    message: Message,
    id: string,
  ): Promise<{ document: UiDocument; revision: number; pending: boolean }> {
    const record = await this.store.record(message.server, "ui", id);
    if (!record) throw new ToolError("Interface not found.");
    const state = record.value as unknown as UiState;
    if (state.channel !== message.channel)
      throw new ToolError("Wrong channel.");
    await this.authorize(message, state.channel);
    if (state.pending && state.pendingOperation) {
      const result = await this.tools.recordedResult(state.pendingOperation);
      if (result) {
        const document = result.ui ?? {
          version: 1,
          type: "card",
          title: "Result",
          text: result.text.slice(0, 3500),
        };
        if (
          await this.store.putRecord(
            message.server,
            "ui",
            id,
            { ...state, document, pending: false } as unknown as Json,
            record.revision,
          )
        ) {
          return { document, revision: record.revision + 1, pending: false };
        }
        return this.current(message, id);
      }
    }
    return {
      document: state.document,
      revision: record.revision,
      pending: Boolean(state.pending) || state.expires < Date.now(),
    };
  }
  async prepare(
    message: Message,
    document: UiDocument,
    seed: string,
  ): Promise<{ id: string; revision: number; state: UiState }> {
    validateUi(document);
    const id = uiKey(seed),
      saved = await this.store.record(message.server, "ui", id);
    if (saved)
      return {
        id,
        revision: saved.revision,
        state: saved.value as unknown as UiState,
      };
    const state: UiState = {
      document,
      channel: message.channel,
      owner: message.author,
      expires: Date.now() + 86400000,
    };
    await this.store.putRecord(
      message.server,
      "ui",
      id,
      state as unknown as Json,
      0,
    );
    return { id, revision: 1, state };
  }
  async act(
    message: Message,
    id: string,
    revision: number,
    index: number,
    interactionId: string,
  ): Promise<{ document: UiDocument; revision: number }> {
    const record = await this.store.record(message.server, "ui", id);
    if (!record) throw new ToolError("This interface is no longer available.");
    const state = record.value as unknown as UiState;
    if (record.revision !== revision || state.pending)
      throw new ToolError(
        "This interface changed or is busy. Use the latest controls.",
      );
    if (state.expires < Date.now())
      throw new ToolError("These controls expired. Ask for a fresh response.");
    if (state.channel !== message.channel)
      throw new ToolError("Use these controls in their original channel.");
    await this.authorize(message, state.channel);
    if (state.document.type === "poll")
      throw new ToolError("Use Discord poll voting.");
    const action = (
      state.document.type === "select"
        ? state.document.options
        : state.document.actions
    )?.[index];
    if (!action) throw new ToolError("Unknown UI action.");
    if (action.action === "history.next" && state.owner !== message.author)
      throw new ToolError(
        "These search controls belong to the requester. Start your own search.",
      );
    const tool = uiActions[action.action]?.tool;
    if (!tool) throw new ToolError("Unknown UI handler.");
    const args = this.tools.validate(tool, actionArguments(action));
    await this.tools.checkAccess(message, tool);
    if (
      !(await this.store.putRecord(
        message.server,
        "ui",
        id,
        {
          ...state,
          pending: true,
          pendingOperation: `ui:${interactionId}`,
        } as unknown as Json,
        revision,
      ))
    )
      throw new ToolError("Another member already used these controls.");
    let result: ToolResult;
    try {
      result = await this.tools.invokeResult(
        message,
        tool,
        args,
        `ui:${interactionId}`,
        "command",
      );
    } catch (error) {
      // A known validation rejection did not execute an action. Unknown outcomes remain blocked.
      if (error instanceof ToolError)
        result = { text: errorSummary(error), status: error.status, reason: errorSummary(error) };
      else throw error;
    }
    const document = result.ui ?? {
      version: 1,
      type: "card",
      title: "Result",
      text: result.text.slice(0, 3500),
    };
    const updated: UiState = { ...state, document, pending: false };
    if (
      !(await this.store.putRecord(
        message.server,
        "ui",
        id,
        updated as unknown as Json,
        revision + 1,
      ))
    )
      throw new ToolError(
        "UI update conflicted. The tool result remains recorded.",
      );
    return { document, revision: revision + 2 };
  }
}
export function registerUiTool(registry: ToolRegistry): void {
  registry.register({
    name: "ui_publish",
    surface: "top",
    description:
      "Present a version-1 Discord UI document: text/card (title,text,actions), select (text,options), or poll (question,answers,durationHours,multiple). Actions have label, registered action, arguments. Registered actions: history.next(cursor), task.complete(id), task.list(), reminder.cancel(id). No executable code. The transport renders this in the final response.",
    fields: {
      document: {
        type: "json",
        description: "Versioned UI document",
        required: true,
      },
    },
    publicResult: (args) => validateUi(args.document).type === "poll",
    access: "member",
    effect: "read",
    retrySafe: true,
    async execute(_context, args) {
      const ui = validateUi(args.document);
      return {
        text: ui.type === "poll" ? `Poll: ${ui.question}` : ui.text,
        ui,
      };
    },
  });
}

export function registerPollTool(registry: ToolRegistry): void {
  registry.register({
    name: "poll_create",
    description:
      "Create a native Discord poll in the final response. Polls are public and use Discord voting.",
    fields: {
      question: {
        type: "string",
        description: "Poll question",
        required: true,
        max: 300,
      },
      answers: {
        type: "json",
        description: "Array of 2–10 distinct answer strings",
        required: true,
      },
      hours: {
        type: "integer",
        description: "Duration in hours, default 24",
        min: 1,
        max: 768,
      },
      multiple: {
        type: "boolean",
        description: "Allow multiple answers, default false",
      },
    },
    access: "member",
    effect: "read",
    retrySafe: true,
    publicResult: () => true,
    async execute(_context, args) {
      const ui = validateUi({
        version: 1,
        type: "poll",
        question: args.question,
        answers: args.answers,
        durationHours: args.hours ?? 24,
        multiple: args.multiple ?? false,
      });
      return { text: "Poll prepared.", ui };
    },
  });
}
