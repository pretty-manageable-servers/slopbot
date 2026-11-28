import { randomUUID } from "node:crypto";
import type { AssistantStore } from "../../assistant/store.js";
import type { AssistantLimits } from "../../assistant/types.js";

/** Server setting. The value "false" turns mention triggers off for the server. */
export const ASSISTANT_MENTIONS_KEY = "assistant_mentions";
const HISTORY_LINES = 5;
const MAX_TEXT_CHARS = 2000;

export interface MentionHistoryLine { author: string; text: string }

export interface MentionTriggerDeps {
  store: AssistantStore;
  limits(): Promise<AssistantLimits>;
  serverSetting(server: string, key: string): Promise<string | undefined>;
  history(channel: string, before: string, limit: number): Promise<MentionHistoryLine[]>;
  now?: () => number;
  id?: () => string;
}

export interface GuildMessageMention {
  server: string;
  channel: string;
  messageId: string;
  author: string;
  authorIsBot: boolean;
  text: string;
  mentionedUserIds: string[];
  isDm: boolean;
}

/** Turns a mention of an enabled assistant user into a `mention` trigger for that user. */
export class MentionTrigger {
  // Key: user and channel. Value: time when the debounce ends (ms).
  private readonly debounceUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly deps: MentionTriggerDeps) {
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
  }

  async onGuildMessage(message: GuildMessageMention): Promise<void> {
    // A DM to Slopbot is already a chat. Bot messages never wake the assistant.
    if (message.isDm || message.authorIsBot) return;
    if (await this.deps.serverSetting(message.server, ASSISTANT_MENTIONS_KEY) === "false") return;

    const mentioned = [...new Set(message.mentionedUserIds)].filter(user => user !== message.author);
    const enabled: string[] = [];
    for (const user of mentioned) if ((await this.deps.store.settings(user))?.enabled) enabled.push(user);
    if (enabled.length === 0) return;

    const { mentionDebounceMinutes } = await this.deps.limits();
    const now = this.now();
    const due = enabled.filter(user => this.claimDebounce(user, message.channel, now, mentionDebounceMinutes));
    if (due.length === 0) return;

    const before = await this.deps.history(message.channel, message.messageId, HISTORY_LINES);
    const payload = { server: message.server, channel: message.channel, messageId: message.messageId, author: message.author, text: message.text.slice(0, MAX_TEXT_CHARS), before };
    for (const user of due) {
      try {
        await this.deps.store.addTrigger({ id: this.id(), kind: "mention", task: null, owner: user, payload, createdAt: now, takenAt: null });
      } catch (error) {
        // A failed write must not block the next mention for the debounce time.
        this.debounceUntil.delete(debounceKey(user, message.channel));
        throw error;
      }
    }
  }

  /** Returns false while the user and channel are inside a debounce. Otherwise it starts one and returns true. */
  private claimDebounce(user: string, channel: string, now: number, minutes: number): boolean {
    for (const [key, until] of this.debounceUntil) if (until <= now) this.debounceUntil.delete(key);
    const key = debounceKey(user, channel);
    if (this.debounceUntil.has(key)) return false;
    this.debounceUntil.set(key, now + minutes * 60_000);
    return true;
  }
}

const debounceKey = (user: string, channel: string) => `${user}\n${channel}`;
