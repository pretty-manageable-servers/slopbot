import { randomUUID } from "node:crypto";

/** Private conversations use this prefix so storage excludes them from server history. */
export const PRIVATE_CHANNEL_PREFIX = "web:";
/** Longest message a user can send to a private chat. */
export const PRIVATE_CHAT_MAX_CHARS = 8000;
/** Longest title. A new chat takes its title from its first message. */
export const PRIVATE_CHAT_TITLE_CHARS = 60;

export function isPrivateChannel(channel: string): boolean {
  return channel.startsWith(PRIVATE_CHANNEL_PREFIX);
}

export function privateChannel(id: string): string {
  return `${PRIVATE_CHANNEL_PREFIX}${id}`;
}

export function newPrivateChatId(): string {
  return randomUUID().replace(/-/g, "");
}

/** The first characters of the first message, on one line. */
export function privateChatTitle(text: string): string {
  return [...text.replace(/\s+/g, " ").trim()].slice(0, PRIVATE_CHAT_TITLE_CHARS).join("");
}

/** DMs share the private storage namespace, with their Discord channel ID preserved for delivery. */
export function directMessageChannel(id: string): string { return `${PRIVATE_CHANNEL_PREFIX}dm:${id}`; }
export function isDirectMessageChannel(channel: string): boolean { return channel.startsWith(`${PRIVATE_CHANNEL_PREFIX}dm:`); }
export function discordChannelId(channel: string): string { return isDirectMessageChannel(channel) ? channel.slice(`${PRIVATE_CHANNEL_PREFIX}dm:`.length) : channel; }
