import type { EngineEnvelope, EngineEvent, Surface, TimedEngineEvent } from "@slopbot/contracts";
import type { Message } from "../domain.js";
import type { MemberProfile } from "../member-directory.js";
import { isDirectMessageChannel, isPrivateChannel } from "../private-chat.js";
import type { UiDocument } from "../ui/schema.js";

/** One Discord server's engine: what DiscordServer owns today, without discord.js. */
export interface Workspace {
  readonly server: string;
  /** The message is already saved when ingested is true (web chats). Same as bot.receive today. */
  submit(message: Message, options?: { ingested?: boolean }): Promise<void>;
  stop(channel: string, user: string, manager: boolean): Promise<string[]>;
  act(channel: string, user: string, card: string, revision: number, index: number, interactionId: string): Promise<{ document: UiDocument; revision: number }>;
  openChat(channel: string): void;
  closeChat(channel: string): void;
}

export interface EngineEventLog {
  /** Every listener gets every event. A row is saved only when the transcript switch is on, or for a web chat. */
  publish(conversation: { server: string; channel: string }, event: EngineEvent): void;
  after(conversation: { server: string; channel: string }, seq: number, limit: number): Promise<EngineEnvelope[]>;
  /** The highest saved seq of the conversation, 0 when none. A page that opens /events?after=<seq> from it misses and repeats nothing. */
  latest(conversation: { server: string; channel: string }): Promise<number>;
  turn(conversation: { server: string; channel: string }, turn: string): Promise<TimedEngineEvent[]>;
  subscribe(conversation: { server: string; channel: string }, listener: (envelope: EngineEnvelope) => void): () => void;
}

export interface Engine {
  workspace(server: string): Promise<Workspace | undefined>;
  readonly events: EngineEventLog;
}

/** Discord authority. The Discord client implements it; the engine and the web client only call it. */
export interface Directory {
  isMember(user: string, server: string): Promise<boolean>;
  canManage(user: string, server: string): Promise<boolean>;
  profiles(server: string, users: readonly string[]): Promise<Map<string, MemberProfile>>;
  channelName(server: string, channel: string): Promise<string | undefined>;
}

/** The surface of a message. Clients set message.surface. Old saved messages: derived from the channel. */
export function surfaceOf(message: Pick<Message, "channel" | "surface">): Surface {
  if (message.surface) return message.surface;
  if (isDirectMessageChannel(message.channel)) return "discord-dm";
  if (isPrivateChannel(message.channel)) return "web";
  return "discord";
}
