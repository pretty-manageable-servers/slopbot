import type { Json } from "../domain.js";
export interface UiActionHandler {
  tool: string;
  fixedArguments?: Record<string, Json>;
}
// Add an entry here to expose an existing registry tool through Discord controls.
export const uiActions: Readonly<Record<string, UiActionHandler>> = {
  "history.next": { tool: "history_search" },
  "task.complete": {
    tool: "task_manage",
    fixedArguments: { action: "complete" },
  },
  "task.list": { tool: "task_manage", fixedArguments: { action: "list" } },
  "reminder.cancel": { tool: "reminder", fixedArguments: { action: "cancel" } },
};
