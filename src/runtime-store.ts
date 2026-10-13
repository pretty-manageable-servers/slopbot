import type { Store } from "./ports.js";
import type { Message } from "./domain.js";
import type { Knowledge, Recall } from "./memory.js";
import type { QueueStore } from "./queue.js";
import type { ToolJournal } from "./tools.js";
import type { ProfileStore } from "./profiles.js";
import type { HarnessJournal } from "./harness-state.js";
import type { TaskRegistry } from "./bot.js";
import type { ServerToolStore } from "./server-tools.js";
import type { HistoryStore } from "./history.js";
import type { RecordStore } from './records.js';
import type { HistorySearch } from './search/history-search.js';
import type { TranscriptStore } from './web-transcripts.js';
import type { WebReplyStore } from './web-replies.js';
import type { ShareStore } from './shares.js';
type Awaitable<T> = T | Promise<T>;

// Settings and task listings are loaded at startup. Their writes are durable
// before acknowledgement; all database-dependent operations are awaited.
export interface RuntimeStore extends Store, Knowledge, Recall, QueueStore, ToolJournal, ProfileStore, HarnessJournal, TaskRegistry, ServerToolStore, HistoryStore, HistorySearch, RecordStore, TranscriptStore, WebReplyStore, ShareStore {
  canonicalMessage(server: string, id: string): Awaitable<Message | undefined>;
  knownAuthors(server: string): Awaitable<{ author: string; named: boolean }[]>;
  identifyAuthor(server: string, author: string, names: readonly string[], bot?: boolean, identity?: Record<string,string>): Awaitable<void>;
  reindex(server: string, channels: readonly string[]): Awaitable<number>;
  purgeUnconfigured(server: string, allowed: readonly string[]): Awaitable<void>;
  revise(message: Message): Promise<void>;
  remove(server: string, channel: string, id: string): Promise<void>;
  delivery(id: string): Awaitable<{ message: Message; content: string; createdAt: number; result: Message | null } | undefined>;
  prepareDelivery(id: string, message: Message, content: string): Awaitable<void>;
  finishDelivery(id: string, result: Message): Awaitable<void>;
  close(): Awaitable<void>;
}
