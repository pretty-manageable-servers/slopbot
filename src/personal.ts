/** The one workspace that hosts every web chat and DM. Not a Discord server. */
export const PERSONAL_SERVER = "__personal__";
/** The workspace of private chats. Its store is in memory only. */
export const INCOGNITO_SERVER = "__incognito__";
export const INCOGNITO_IDLE_MS = 60 * 60 * 1000;
export const CHAT_TITLE_MAX = 60;
export const INCOGNITO_PREFIX = "web:incognito:";               // channel of a private chat
export function personalMemoryChannel(user: string): string { return `user:${user}`; }
export function incognitoChannel(id: string): string { return `${INCOGNITO_PREFIX}${id}`; }
export function isIncognitoChannel(channel: string): boolean { return channel.startsWith(INCOGNITO_PREFIX); }
