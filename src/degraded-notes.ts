/** Allows one note per channel for each window. The window is read on each check, so an admin change applies at once. */
export class DegradedNotes {
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMinutes: () => number) {}

  shouldPost(channel: string, now: number): boolean {
    const windowMs = this.windowMinutes() * 60_000;
    const previous = this.last.get(channel);
    if (previous !== undefined && now - previous < windowMs) return false;
    // Channels are kept in memory only. Drop the expired ones so the map stays small.
    if (this.last.size > 1000) for (const [key, at] of this.last) if (now - at >= windowMs) this.last.delete(key);
    this.last.set(channel, now);
    return true;
  }
}
