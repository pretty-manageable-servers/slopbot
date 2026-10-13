/** Live permission facts for one user in one channel or thread. The Discord adapter fills them in. */
export interface ChannelFacts {
  thread: boolean;
  privateThread: boolean;
  viewChannel: boolean;
  readMessageHistory: boolean;
  sendMessages: boolean;
  sendMessagesInThreads: boolean;
  /** Only read for private threads. */
  threadMember: boolean;
}
export interface ChannelAccessSource {
  /** Undefined when the user is not in the server, or the channel is not in it. */
  facts(server: string, channel: string, user: string): Promise<ChannelFacts | undefined>;
}
export interface ChannelAccessResult { view: boolean; send: boolean }
interface CacheEntry { server: string; channel: string; user: string; expires: number; result: ChannelAccessResult }

const TTL_MS = 30_000;

function rule(facts: ChannelFacts | undefined): ChannelAccessResult {
  if (!facts) return { view: false, send: false };
  const view = facts.viewChannel && facts.readMessageHistory && (!facts.privateThread || facts.threadMember);
  return { view, send: view && (facts.thread ? facts.sendMessagesInThreads : facts.sendMessages) };
}

/** Answers what a user can view and send in a channel or thread, from live Discord permissions. */
export interface AccessChange { server?: string; channel?: string; user?: string }

export class ChannelAccess {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly clearListeners = new Set<(change: AccessChange) => void>();
  // Any clear bumps the epoch, so an answer that was in flight during a clear is not cached.
  private epoch = 0;
  constructor(private readonly source: ChannelAccessSource, private readonly now: () => number = Date.now) {}
  async check(server: string, channel: string, user: string): Promise<ChannelAccessResult> {
    const key = JSON.stringify([server, channel, user]), cached = this.entries.get(key);
    if (cached && cached.expires > this.now()) return cached.result;
    const epoch = this.epoch;
    const result = rule(await this.source.facts(server, channel, user));
    if (epoch === this.epoch) {
      const now = this.now();
      for (const [old, entry] of this.entries) if (entry.expires <= now) this.entries.delete(old);
      this.entries.set(key, { server, channel, user, expires: now + TTL_MS, result });
    }
    return result;
  }
  /** Called after each clear, so open streams can check again at once. Returns the unsubscribe function. */
  onClear(listener: (change: AccessChange) => void): () => void {
    this.clearListeners.add(listener);
    return () => { this.clearListeners.delete(listener); };
  }
  private notify(change: AccessChange): void {
    for (const listener of this.clearListeners) listener(change);
  }
  /** Use for guildMemberUpdate and guildMemberRemove. */
  clearUser(server: string, user: string): void {
    this.epoch++;
    for (const [key, entry] of this.entries) if (entry.server === server && entry.user === user) this.entries.delete(key);
    this.notify({ server, user });
  }
  /** Use for channelUpdate, threadUpdate, threadDelete and channelDelete. */
  clearChannel(channel: string): void {
    this.epoch++;
    for (const [key, entry] of this.entries) if (entry.channel === channel) this.entries.delete(key);
    this.notify({ channel });
  }
  /** Use for roleUpdate, because any role can change anyone's permissions. */
  clearServer(server: string): void {
    this.epoch++;
    for (const [key, entry] of this.entries) if (entry.server === server) this.entries.delete(key);
    this.notify({ server });
  }
}
