import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openEngineStream, streamUrlAfter } from "./live";

/** An EventSource the test drives by hand. */
class FakeSource {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
  static all: FakeSource[] = [];
  readyState = FakeSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners: Record<string, ((event: { data: string }) => void)[]> = {};
  constructor(readonly url: string) { FakeSource.all.push(this); }
  addEventListener(type: string, listener: (event: { data: string }) => void) { (this.listeners[type] ??= []).push(listener); }
  close() { this.readyState = FakeSource.CLOSED; }
  emit(type: string, data: unknown) { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) }); }
  fail() { this.readyState = FakeSource.CLOSED; this.onerror?.(); }
}

const page = new EventTarget() as EventTarget & { visibilityState: string };
const latest = () => FakeSource.all.at(-1)!;
const envelope = (seq: number) => ({ seq, at: 1, conversation: { server: "s", channel: "c" }, event: { type: "turn.start", turn: "t" } });

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.all = [];
  page.visibilityState = "visible";
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", new EventTarget());
});
// Every stream listens on the shared page, so each test closes the ones it opened.
const opened: (() => void)[] = [];
afterEach(() => { for (const close of opened.splice(0)) close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const open = (url = "/api/chats/a/events") => {
  const handlers = { onEvent: vi.fn(), onClosed: vi.fn(), onStatus: vi.fn() };
  const close = openEngineStream(url, handlers);
  opened.push(close);
  return { handlers, close };
};

describe("openEngineStream", () => {
  test("a stream the browser gave up on opens again after the last event it saw", () => {
    const { handlers } = open();
    latest().emit("engine", envelope(41));
    latest().fail();
    vi.advanceTimersByTime(1000);
    expect(latest().url).toBe("/api/chats/a/events?after=41");
    expect(handlers.onClosed).not.toHaveBeenCalled();
  });

  test("back on the tab, it opens at once, without the backoff", () => {
    open();
    latest().fail();
    latest().fail(); // nothing new opened yet
    expect(FakeSource.all).toHaveLength(1);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSource.all).toHaveLength(1);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSource.all).toHaveLength(2);
  });

  test("after 10 seconds hidden, an open stream opens again from the last event; a short switch keeps it", () => {
    open();
    latest().onopen?.();
    latest().emit("engine", envelope(9));
    const hide = () => { page.visibilityState = "hidden"; page.dispatchEvent(new Event("visibilitychange")); };
    const show = () => { page.visibilityState = "visible"; page.dispatchEvent(new Event("visibilitychange")); };
    hide(); vi.advanceTimersByTime(3000); show();
    expect(FakeSource.all).toHaveLength(1);
    hide(); vi.advanceTimersByTime(10_000); show();
    expect(FakeSource.all).toHaveLength(2);
    expect(FakeSource.all[0]!.readyState).toBe(FakeSource.CLOSED);
    expect(latest().url).toBe("/api/chats/a/events?after=9");
  });

  test("a stream the bot ended for an error opens again; one it ended for access does not", () => {
    const { handlers } = open();
    latest().emit("closed", { reason: "error" });
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all).toHaveLength(2);
    latest().emit("closed", { reason: "access" });
    vi.advanceTimersByTime(60_000);
    page.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSource.all).toHaveLength(2);
    expect(handlers.onClosed).toHaveBeenCalledWith("access");
  });

  test("the wait grows to at most 30 seconds and resets once a stream opens", () => {
    open();
    for (const wait of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      latest().fail();
      vi.advanceTimersByTime(wait - 1);
      const count = FakeSource.all.length;
      vi.advanceTimersByTime(1);
      expect(FakeSource.all).toHaveLength(count + 1);
    }
    latest().onopen?.();
    latest().fail();
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all).toHaveLength(9);
  });

  test("a short drop shows nothing; one that lasts 5 seconds says Reconnecting…", () => {
    const { handlers } = open();
    latest().onopen?.();
    latest().fail();
    vi.advanceTimersByTime(1000);
    latest().onopen?.();
    expect(handlers.onStatus).not.toHaveBeenCalledWith("Reconnecting…");
    latest().fail();
    vi.advanceTimersByTime(5000);
    expect(handlers.onStatus).toHaveBeenLastCalledWith("Reconnecting…");
    latest().onopen?.();
    expect(handlers.onStatus).toHaveBeenLastCalledWith("");
  });

  test("closing it stops all retries", () => {
    const { close } = open();
    latest().fail();
    close();
    vi.advanceTimersByTime(60_000);
    page.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSource.all).toHaveLength(1);
  });

  test("the channel URL already has a query", () => {
    expect(streamUrlAfter("/api/x/events?server=1", 7)).toBe("/api/x/events?server=1&after=7");
  });
});
