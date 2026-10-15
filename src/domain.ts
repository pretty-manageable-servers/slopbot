export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Attachment { readonly name: string; readonly url: string; readonly contentType?: string; readonly size?: number; readonly preview?: boolean }

/** Reasoning effort a user can choose. Providers that do not support it ignore it. */
export const EFFORTS = ["low", "medium", "xhigh"] as const;
export type Effort = typeof EFFORTS[number];
export function parseEffort(value: unknown): Effort | undefined {
  return EFFORTS.find(effort => effort === value);
}

export interface Message {
  readonly effort?: Effort;
  readonly attachments?: readonly Attachment[];
  readonly id: string;
  readonly server: string;
  readonly channel: string;
  readonly author: string;
  readonly text: string;
  readonly replyTo?: string;
  readonly taskId?: string;
  readonly addressed?: boolean;
  readonly timestamp?: number;
  readonly authorIdentity?: Record<string, string>;
  readonly authorName?: string;
  readonly authorAliases?: readonly string[];
  readonly isBot?: boolean;
  /** "web" marks a Discord webhook post that a signed-in user sent from the web console. */
  readonly source?: "web" | "voice";
  readonly transient?: boolean;
  /** Web chat only: short-lived links of the images in this message, for the model. In memory; the saved row keeps attachments only. */
  readonly modelImages?: readonly { url: string; label: string }[];
  readonly revisionTimestamp?: number;
  /** Set on a request the bot answers. Its non-image files are copied to the sandbox before the run. */
  readonly uploadFiles?: true;
  /** Set by the worker after the upload: sandbox paths written, and failures as "name: reason". */
  readonly uploads?: { readonly files: readonly string[]; readonly failed: readonly string[] };
}

export function hasMessageContent(message: Message): boolean {
  return Boolean(message.text.trim() || message.attachments?.length || message.modelImages?.length || message.uploads?.files.length);
}

export interface PromptItem {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly toolCalls?: readonly ModelToolCall[];
  readonly toolCallId?: string;
  readonly content: string;
  readonly author?: string;
  readonly contextOnly?: boolean;
  readonly images?: readonly { url: string; label: string }[];
  readonly sourceIds?: readonly string[];
}

export interface ModelToolCall { readonly id: string; readonly name: string; readonly arguments: Record<string, Json> }
export interface ModelTool { readonly type: "function"; readonly function: { readonly name: string; readonly description: string; readonly parameters: Json } }

export interface Prompt {
  readonly prefixVersion: string;
  readonly cacheScope?: string;
  readonly prefix: readonly PromptItem[];
  readonly history: readonly PromptItem[];
  readonly inputs: readonly PromptItem[];
  readonly maxOutputTokens?: number;
  readonly effort?: Effort;
  readonly purpose?: "reply" | "checkpoint" | "inspection";
  readonly tools?: readonly ModelTool[];
}

export type ModelEvent =
  | { readonly kind: "text"; readonly payload: { readonly text: string } }
  | { readonly kind: "reasoning" | "opaque" | "usage" | "tool_call"; readonly payload: Json };

export interface Reply {
  readonly ui?: import('./ui/schema.js').UiDocument;
  readonly toolActivity?: readonly import("./tool-activity.js").ToolActivity[];
  readonly runId: string;
  readonly text: string;
  readonly contextVersion?: number;
}

export function promptItems(prompt: Prompt): readonly PromptItem[] {
  return [...prompt.prefix, ...prompt.history, ...prompt.inputs];
}

// Transport adapters use this boundary before passing untrusted events to the core.
export function parseMessage(input: unknown): Message {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Message must be an object");
  }
  const value = input as Record<string, unknown>;
  for (const field of ["id", "server", "channel", "author", "text"] as const) {
    if (typeof value[field] !== "string" || (field !== "text" && value[field].length === 0)) {
      throw new TypeError(`Invalid message field: ${field}`);
    }
  }
  for (const field of ["replyTo", "taskId", "authorName"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field].length === 0)) {
      throw new TypeError(`Invalid message field: ${field}`);
    }
  }
  if (value.addressed !== undefined && typeof value.addressed !== "boolean") {
    throw new TypeError("Invalid message field: addressed");
  }
  if (value.timestamp !== undefined && (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp))) {
    throw new TypeError("Invalid message field: timestamp");
  }
  if (value.revisionTimestamp !== undefined && (typeof value.revisionTimestamp !== "number" || !Number.isFinite(value.revisionTimestamp))) throw new TypeError("Invalid revision timestamp");
  if (value.isBot !== undefined && typeof value.isBot !== "boolean") throw new TypeError("Invalid bot flag");
  if (value.source !== undefined && value.source !== "web" && value.source !== "voice") throw new TypeError("Invalid message source");
  if (value.transient !== undefined && typeof value.transient !== "boolean") throw new TypeError("Invalid transient message flag");
  if (value.authorAliases !== undefined && (!Array.isArray(value.authorAliases) || value.authorAliases.some(alias => typeof alias !== "string"))) throw new TypeError("Invalid author aliases");
  if (value.authorIdentity !== undefined && (!value.authorIdentity || typeof value.authorIdentity !== "object" || Array.isArray(value.authorIdentity) || Object.values(value.authorIdentity).some(item => typeof item !== "string"))) throw new TypeError("Invalid Discord identity");
  if (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.some(item => !item || typeof item.name !== "string" || typeof item.url !== "string" || (item.contentType !== undefined && typeof item.contentType !== "string") || (item.preview !== undefined && typeof item.preview !== "boolean") || (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0))))) throw new TypeError("Invalid attachments");
  if (value.effort !== undefined && parseEffort(value.effort) === undefined) throw new TypeError("Invalid effort");
  if (value.modelImages !== undefined && (!Array.isArray(value.modelImages) || value.modelImages.some(item => !item || typeof item.url !== "string" || typeof item.label !== "string"))) throw new TypeError("Invalid model images");
  return {
    ...(value.modelImages ? { modelImages: value.modelImages as { url: string; label: string }[] } : {}),
    ...(value.effort ? { effort: value.effort as Effort } : {}),
    ...(value.attachments ? { attachments: value.attachments as Attachment[] } : {}),
    ...(value.authorIdentity ? { authorIdentity: value.authorIdentity as Record<string,string> } : {}),
    ...(value.authorName ? { authorName: value.authorName as string } : {}),
    ...(value.authorAliases ? { authorAliases: value.authorAliases as string[] } : {}),
    ...(value.isBot !== undefined ? { isBot: value.isBot as boolean } : {}),
    ...(value.source !== undefined ? { source: value.source === "voice" ? "voice" as const : "web" as const } : {}),
    ...(value.revisionTimestamp !== undefined ? { revisionTimestamp: value.revisionTimestamp as number } : {}),
    ...(value.transient !== undefined ? { transient: value.transient as boolean } : {}),
    ...(value.uploadFiles === true ? { uploadFiles: true as const } : {}),
    ...(value.uploads ? { uploads: value.uploads as { files: string[]; failed: string[] } } : {}),
    id: value.id as string, server: value.server as string,
    channel: value.channel as string, author: value.author as string, text: value.text as string,
    ...(value.replyTo !== undefined ? { replyTo: value.replyTo as string } : {}),
    ...(value.taskId !== undefined ? { taskId: value.taskId as string } : {}),
    ...(value.addressed !== undefined ? { addressed: value.addressed as boolean } : {}),
    ...(value.timestamp !== undefined ? { timestamp: value.timestamp as number } : {}),
  };
}
