import type { Json, PromptItem } from "./domain.js";

export interface ContextField { field: string; value: Json; self_reported: boolean; source_ids: readonly string[]; scope?: 'global' }
export interface ContextPerson { user_id: string; display_name: string; requester?: true; discord?: Json; fields: readonly ContextField[] }
export interface ContextInput { request: Record<string, Json>; people: readonly ContextPerson[]; evidence: readonly Json[] }

const isEmpty = (value: Json) => value === null || value === false || value === "" ||
  (Array.isArray(value) && value.length === 0) || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

// One line per value: plain strings stay as they are, anything else is compact JSON.
const scalar = (value: Json) => typeof value === "string" && !/[\r\n]/.test(value) ? value : JSON.stringify(value);
const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ");

function fieldText(field: ContextField): string {
  return `${oneLine(field.field)}=${scalar(field.value)}${field.scope === 'global' ? ' (global, owner-supplied)' : ''}${field.self_reported ? "" : " (not self-reported)"}`;
}

/** One line of the People section. Used by contextBlock and by the budget count. */
export function personLine(person: ContextPerson): string {
  const parts = [
    ...(person.discord !== undefined && !isEmpty(person.discord) ? [`discord=${JSON.stringify(person.discord)}`] : []),
    ...person.fields.map(fieldText),
  ];
  return `- ${oneLine(person.display_name)} (user_id ${person.user_id})${person.requester ? " [requester]" : ""}${parts.length ? ` ${parts.join("; ")}` : ""}`;
}

/** One line of the Evidence section. Used by contextBlock and by the budget count. */
export function evidenceLine(evidence: Json): string {
  return `- ${JSON.stringify(evidence)}`;
}

/** The single context item that replaces the separate request, people and evidence turns. */
export function contextBlock(input: ContextInput): PromptItem {
  const sections: string[] = [];
  // is_task is always shown, so the tool rules can point at it even when it is false.
  const request = Object.entries(input.request).filter(([key, value]) => key === "is_task" || !isEmpty(value)).map(([key, value]) => `${oneLine(key)}: ${scalar(value)}`);
  if (request.length) sections.push(["Request context:", ...request].join("\n"));
  if (input.people.length) sections.push(["People:", ...input.people.map(personLine)].join("\n"));
  if (input.evidence.length) sections.push(["Evidence:", ...input.evidence.map(evidenceLine)].join("\n"));
  return { role: "user", contextOnly: true, content: sections.join("\n\n") };
}
