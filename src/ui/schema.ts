import { uiActions } from "./actions.js";
import type { Json } from "../domain.js";
import { ToolError } from "../tools.js";
export interface UiAction {
  label: string;
  action: string;
  arguments: Record<string, Json>;
}
export type UiDocument =
  | {
      version: 1;
      type: "text" | "card";
      title?: string;
      text: string;
      actions?: UiAction[];
    }
  | {
      version: 1;
      type: "select";
      title?: string;
      text: string;
      options: UiAction[];
    }
  | {
      version: 1;
      type: "poll";
      question: string;
      answers: string[];
      durationHours: number;
      multiple?: boolean;
    };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
export function validateUi(value: unknown): UiDocument {
  if (!object(value) || value.version !== 1)
    throw new ToolError("UI must be an object with version 1.");
  const allowed =
    value.type === "poll"
      ? ["version", "type", "question", "answers", "durationHours", "multiple"]
      : value.type === "select"
        ? ["version", "type", "title", "text", "options"]
        : ["version", "type", "title", "text", "actions"];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ToolError("Unsupported UI property.");
  if (value.type === "poll") {
    if (
      !string(value.question, 300) ||
      !Array.isArray(value.answers) ||
      value.answers.length < 2 ||
      value.answers.length > 10 ||
      !value.answers.every((item) => string(item, 55)) ||
      new Set(value.answers).size !== value.answers.length ||
      !Number.isInteger(value.durationHours) ||
      Number(value.durationHours) < 1 ||
      Number(value.durationHours) > 768 ||
      (value.multiple !== undefined && typeof value.multiple !== "boolean")
    )
      throw new ToolError(
        "Poll needs a question, 2–10 distinct answers, and durationHours from 1 to 768.",
      );
  } else {
    if (
      !["text", "card", "select"].includes(String(value.type)) ||
      !string(value.text, 3500) ||
      (value.title !== undefined && !string(value.title, 150))
    )
      throw new ToolError(
        "UI needs supported type and text; title is optional.",
      );
    const entries =
      value.type === "select" ? value.options : (value.actions ?? []);
    if (
      !Array.isArray(entries) ||
      entries.length > (value.type === "select" ? 25 : 5) ||
      (value.type === "select" && !entries.length)
    )
      throw new ToolError("Invalid UI actions.");
    for (const entry of entries)
      if (
        !object(entry) ||
        Object.keys(entry).some(
          (key) => !["label", "action", "arguments"].includes(key),
        ) ||
        !string(entry.label, 80) ||
        !Object.hasOwn(uiActions, String(entry.action)) ||
        !object(entry.arguments)
      )
        throw new ToolError(
          "Use a registered UI action, label, and arguments.",
        );
  }
  return value as unknown as UiDocument;
}
