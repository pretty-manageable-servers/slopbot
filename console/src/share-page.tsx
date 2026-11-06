// The public share page (/s/<id>). The bot puts the frozen copy in #share-data (sharePageData in src/shares.ts);
// this draws it with the kit, like a chat: markdown, images, tool rows, and show_ui and show_widget visuals.
import "./app.css";
import "./prefs";
import { Button, ChatHeader, ChatTheme, ChatTranscript, ToolViewsProvider, defaultToolViews } from "agentic-ui-kit";
import { VisualsProvider, uiMarkupToolView, widgetToolView } from "agentic-ui-kit/visuals";
import type { ShareData } from "@slopbot/contracts";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, api } from "./api";
import { Loader, Logo } from "./logo";
import { AUTHOR, shareMessages } from "./share-data";
import { uiComponents } from "./ui-components";

/** The console's chat page keeps this ID through the sign-in, then continues the share (chat-page.tsx). */
const SHARE_KEY = "slopbot-share";
const WIDGET_HOST = { frameUrl: "/console/widget-frame.html" };
const toolViews = { ...defaultToolViews, show_ui: uiMarkupToolView(), show_widget: widgetToolView() };

function SharePage({ data }: { data: ShareData }) {
  const [messages] = useState(() => shareMessages(data));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const copiesFiles = data.messages.some((m) => m.images.length || m.files.length);

  // Copies the share into a new private chat of the signed-in user. Signed-out users sign in first.
  const continueShare = async () => {
    setBusy(true);
    setProblem("");
    try {
      try { await api.session(); } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) throw error;
        try { sessionStorage.setItem(SHARE_KEY, data.id); } catch { /* the user continues by hand after signing in */ }
        location.href = "/auth/login";
        return;
      }
      const chat = await api.continueShare(data.id);
      location.href = `/console/chat/${encodeURIComponent(chat.id)}`;
    } catch (error) {
      setProblem(error instanceof ApiError && error.status === 404 ? "This shared chat is no longer available." : (error as Error).message);
      setBusy(false);
    }
  };

  return (
    <ToolViewsProvider tools={toolViews}>
      <VisualsProvider components={uiComponents} host={WIDGET_HOST}>
        <ChatTranscript
          className="h-dvh"
          messages={messages}
          renderPart={(part) => (part.type === "custom" && part.kind === AUTHOR ? <p className="text-sm font-medium text-chat-fg">{String(part.data)}</p> : undefined)}
          header={
            <ChatHeader
              leading={<a href="/" aria-label="Slopbot" className="inline-flex"><Logo size={22} /></a>}
              title="Shared conversation"
              actions={<Button variant="primary" size="sm" isDisabled={busy} onPress={() => void continueShare()}>Continue in Slopbot</Button>}
            />
          }
          notice={
            <p role="status" className="text-sm text-chat-muted">
              {problem || <><strong className="font-medium text-chat-fg">Shared from Slopbot.</strong> This is a frozen copy. Later messages are not included.{copiesFiles && " Images and files are not copied when you continue."}</>}
            </p>
          }
        />
      </VisualsProvider>
    </ToolViewsProvider>
  );
}

function readData(): ShareData | undefined {
  try { return JSON.parse(document.getElementById("share-data")?.textContent ?? "") as ShareData; } catch { return undefined; }
}

const data = readData();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatTheme className="contents" icons={{ activity: <Loader size={18} />, activityDone: <Logo size={18} /> }}>
      {data ? <SharePage data={data} /> : <p className="p-6 text-chat-muted">This shared conversation could not be read.</p>}
    </ChatTheme>
  </StrictMode>,
);
