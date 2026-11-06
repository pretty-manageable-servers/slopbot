import type { ChatGateway } from "../bot.js";
import type { Message } from "../domain.js";
import type { LlmMode, LlmRouter } from "../llm-mode.js";
import type { StoredFile } from "../object-storage.js";
import type { ToolActivity } from "../tool-activity.js";
import type { ToolContext, ToolRegistry } from "../tools.js";
import type { Directory } from "./api.js";

/** Degraded-mode wiring for the server: the router, the live mode and the note window. Absent in mock runs. */
export interface DegradedRouting { router: LlmRouter; mode: () => LlmMode; statusNoteMinutes: () => number }

/**
 * What a Workspace needs from the chat platform that hosts it. The platform client implements it; the engine only calls it.
 * Callbacks may be called while the Workspace is built, but only after the platform has finished its own constructor,
 * so an implementation may reach the Workspace lazily.
 */
export interface WorkspacePorts {
  /** The Manage Server check of the tool registry. */
  readonly directory: Pick<Directory, "canManage">;
  /** Delivery to the platform: replies, the typing indicator and thread creation. The Bot sends through it. */
  readonly gateway: ChatGateway;
  /** Throws a ToolError when the message may not use the channel. */
  validateChannel(message: Message, channel: string, parentOnly?: boolean): Promise<void>;
  /** Posts a reply from a worker (reminder, schedule, fix watch, failed job). */
  reply(message: Message, text: string, deliveryId?: string): Promise<void>;
  typing(channel: string): () => void;
  /** The text channels whose name contains the query and that the author and Slopbot can both see, one `name: <#id>` line each, or a note when none match. */
  findChannels(message: Message, query: string): Promise<string>;
  /** The thread that Slopbot started from this message, or undefined. Throws nothing for a missing thread. */
  taskThread(message: Message): Promise<string | undefined>;
  /** Normalized messages of a channel for the history import, newest first. Throws a ToolError when the channel is unavailable. */
  fetchHistory(channel: string, before: string | null | undefined, limit: number): Promise<Message[]>;
  /** One normalized message, as it is now. Throws a ToolError when the channel is unavailable. */
  fetchMessage(channel: string, id: string): Promise<Message>;
  /** The attachments of a stored message, or undefined when the channel has no messages. */
  imageAttachments(channel: string, id: string): Promise<{ name: string; url: string; contentType?: string }[] | undefined>;
  sendStoredFile(context: ToolContext, file: StoredFile, bytes: Uint8Array): Promise<void>;
  /** The reminder target of a message, e.g. the text chat of a voice session. */
  reminderChannel(message: Message): string | undefined;
  /** Called after the file tools are registered and before the usage tool: the platform registers its own tools here. */
  registerTools(tools: ToolRegistry): void;
  onToolActivity(message: Message, activity: ToolActivity): Promise<void>;
}
