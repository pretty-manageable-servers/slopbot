// The live engine stream of a chat or a channel (GET .../events): each engine event goes to onEvent, and the stream's
// state goes to onStatus as a line for the page header. A dropped stream opens again from the last event it saw
// (?after=<seq>, the bot sends what was missed): after a backoff, and at once when the tab shows again or the device is
// back online. Phones freeze background tabs and drop their connections, so this is the normal case on Android.
// Only a "closed" event with reason "access" ends the stream for good.
import type { EngineEnvelope } from "@slopbot/contracts";

/** The longest wait between two attempts to open the stream again. */
const MAX_RETRY_MS = 30_000;
/** A reconnect that takes less than this shows nothing: coming back to the tab must not flash a status line. */
const QUIET_MS = 5_000;
/**
 * A tab hidden this long opens its stream again when it shows: a phone can freeze the tab and leave a stream that
 * looks open but is dead. The new stream starts after the last event, so it costs one request and what was missed.
 */
const HIDDEN_MS = 10_000;

/** The stream URL that starts after the event `seq`. */
export const streamUrlAfter = (url: string, seq: number) => `${url}${url.includes("?") ? "&" : "?"}after=${seq}`;

/** Opens an engine stream. Returns the function that closes it. */
export function openEngineStream(url: string, handlers: {
  onEvent: (envelope: EngineEnvelope) => void;
  /** The bot ended the stream for good: the user lost access. `reason` is the bot's reason ("access"). */
  onClosed: (reason: string | undefined) => void;
  onStatus: (text: string) => void;
}): () => void {
  let source: EventSource | undefined;
  let last: number | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let ended = false;
  let notice: ReturnType<typeof setTimeout> | undefined;
  let hiddenAt: number | undefined;

  // Says "Reconnecting…" only when the stream stays down for QUIET_MS.
  const troubled = () => {
    notice ??= setTimeout(() => handlers.onStatus("Reconnecting…"), QUIET_MS);
  };
  const fine = () => {
    clearTimeout(notice);
    notice = undefined;
    handlers.onStatus("");
  };

  const open = () => {
    clearTimeout(retry);
    retry = undefined;
    source?.close();
    const current = new EventSource(last === undefined ? url : streamUrlAfter(url, last));
    source = current;
    current.addEventListener("engine", (event) => {
      let envelope: EngineEnvelope;
      try { envelope = JSON.parse((event as MessageEvent<string>).data) as EngineEnvelope; } catch { return; }
      if (envelope.seq !== undefined) last = envelope.seq;
      handlers.onEvent(envelope);
    });
    current.addEventListener("closed", (event) => {
      current.close();
      let reason: string | undefined;
      try { reason = JSON.parse((event as MessageEvent<string>).data).reason; } catch { /* no reason */ }
      if (reason === "access") end(reason);
      else later();
    });
    current.onopen = () => {
      failures = 0;
      fine();
    };
    // The browser retries a dropped connection by itself (CONNECTING). It gives up (CLOSED) on an error answer,
    // for example a 502 from the proxy while the phone wakes up.
    current.onerror = () => {
      if (current.readyState === EventSource.CLOSED) later();
      else troubled();
    };
  };

  const later = () => {
    if (ended || retry) return;
    troubled();
    retry = setTimeout(open, Math.min(MAX_RETRY_MS, 1000 * 2 ** failures++));
  };

  // Back on the tab or online: do not wait for the backoff. After a long time hidden, do not trust an open stream.
  const wake = () => {
    if (ended) return;
    if (document.visibilityState !== "visible") {
      hiddenAt ??= Date.now();
      return;
    }
    const away = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
    hiddenAt = undefined;
    if (retry || source?.readyState === EventSource.CLOSED || away >= HIDDEN_MS) open();
  };

  const stopListening = () => {
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("online", wake);
    window.removeEventListener("pageshow", wake);
  };

  const end = (reason: string | undefined) => {
    ended = true;
    clearTimeout(retry);
    clearTimeout(notice);
    stopListening();
    handlers.onClosed(reason);
  };

  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);
  open();
  return () => {
    ended = true;
    clearTimeout(retry);
    clearTimeout(notice);
    stopListening();
    source?.close();
  };
}
