// The live engine stream of a chat or a channel (GET .../events): each engine event goes to onEvent, and the stream's
// state goes to onStatus as a line for the page header. The stream ends with a "closed" event, which carries why.
import type { EngineEnvelope } from "@slopbot/contracts";

/** Opens an engine stream. Returns the function that closes it. */
export function openEngineStream(url: string, handlers: {
  onEvent: (envelope: EngineEnvelope) => void;
  /** The bot ended the stream. `reason` is the bot's reason when it sent one (for example "access"). */
  onClosed: (reason: string | undefined) => void;
  onStatus: (text: string) => void;
}): () => void {
  const source = new EventSource(url);
  source.addEventListener("engine", (event) => {
    let envelope: EngineEnvelope;
    try { envelope = JSON.parse((event as MessageEvent<string>).data) as EngineEnvelope; } catch { return; }
    handlers.onEvent(envelope);
  });
  source.addEventListener("closed", (event) => {
    source.close();
    let reason: string | undefined;
    try { reason = JSON.parse((event as MessageEvent<string>).data).reason; } catch { /* no reason */ }
    handlers.onClosed(reason);
  });
  source.onopen = () => handlers.onStatus("");
  source.onerror = () => handlers.onStatus(source.readyState === EventSource.CLOSED ? "Disconnected." : "Reconnecting…");
  return () => source.close();
}
