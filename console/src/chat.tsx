// One private chat on screen: the saved messages, then the bot's live stream folded into kit messages.
import { ChatHeader, ChatView, EmptyState, ToolViewsProvider, UiComponentsProvider, defaultToolViews, uiMarkupToolView } from "agentic-ui-kit";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { applyBotEvent, chatMessages, emptyChat, toKitMessage, withRunSteps, type BotEvent, type BotMessage, type ChatState, type RunStep } from "./events";
import { uiComponents } from "./ui-components";

const KINDS = ["message", "run.start", "run.delta", "run.tool", "run.end"] as const;
const toolViews = { ...defaultToolViews, show_ui: uiMarkupToolView() };

/** The thinking and tool steps of each reply on the page, from its runs. A run that fails to load is left out. */
async function replySteps(messages: BotMessage[]): Promise<Map<string, RunStep[]>> {
  const replies = messages.filter((m) => m.slopbot && m.runIds.length);
  const loaded = await Promise.all(replies.map(async (m) => {
    const runs = await Promise.all(m.runIds.map((runId) => api.run(runId).then((run) => run.steps as RunStep[], () => [])));
    return [m.id, runs.flat()] as const;
  }));
  return new Map(loaded);
}

export function Chat({ id, title, onCreate }: { id: string | undefined; title: string; onCreate: () => Promise<string> }) {
  const [state, setState] = useState<ChatState | null>(id ? null : emptyChat());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!id) return;
    let source: EventSource | undefined, closed = false;
    const open = async () => {
      const page = await api.messages(id);
      if (closed) return;
      const messages = page.messages as BotMessage[];
      setState(emptyChat(messages.map((m) => toKitMessage(m, id)), page.streamId));
      // Tool rows and show_ui of earlier replies come from their runs, after the text shows.
      void replySteps(messages).then((steps) => {
        if (!closed) setState((s) => s && { ...s, saved: s.saved.map((m) => (steps.get(m.id) ? withRunSteps(m, steps.get(m.id)!) : m)) });
      });
      source = new EventSource(api.streamUrl(id, page.streamId));
      for (const type of KINDS) {
        source.addEventListener(type, (event) => {
          const message = event as MessageEvent<string>;
          let data: unknown;
          try { data = JSON.parse(message.data); } catch { return; }
          const bot = { type, id: Number(message.lastEventId) || 0, data } as BotEvent;
          setState((s) => (s ? applyBotEvent(s, bot, id) : s));
        });
      }
      // The server pruned events after this position: load the newest page again.
      source.addEventListener("reset", () => { source?.close(); void open().catch((e: Error) => setError(e.message)); });
      source.addEventListener("closed", () => { source?.close(); setStatus("Live updates stopped. Reload to check again."); });
      source.onopen = () => setStatus("");
      source.onerror = () => setStatus(source?.readyState === EventSource.CLOSED ? "Disconnected." : "Reconnecting…");
    };
    open().catch((e: Error) => setError(e.message));
    return () => { closed = true; source?.close(); };
  }, [id]);

  const messages = useMemo(() => (state ? chatMessages(state) : []), [state]);
  const busy = messages.some((m) => m.status === "streaming");

  if (error) return <div className="page-note"><p>{error}</p></div>;
  if (!state) return <div className="page-note" aria-busy="true" />;
  return (
    <UiComponentsProvider components={uiComponents}>
    <ToolViewsProvider tools={toolViews}>
    <ChatView
      messages={messages}
      busy={busy}
      onSend={(text) => {
        void (async () => {
          const chat = id ?? (await onCreate());
          await api.send(chat, text);
        })().catch((e: Error) => setError(e.message));
      }}
      onStop={id ? () => void api.stop(id).catch((e: Error) => setError(e.message)) : undefined}
      header={<ChatHeader title={messages.length ? title || "New chat" : ""} actions={status ? <span role="status">{status}</span> : undefined} />}
      composer={{ placeholder: messages.length ? "Reply to Slopbot…" : "How can I help you today?" }}
      emptyState={(composer) => <EmptyState greeting="What can Slopbot do for you?">{composer}</EmptyState>}
      disclaimer="Slopbot can make mistakes. Check important answers."
    />
    </ToolViewsProvider>
    </UiComponentsProvider>
  );
}
