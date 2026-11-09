// The share page's view: a frozen chat drawn with the kit, like a chat. share-page.tsx mounts it on the page; the
// stories draw it on the fake bot's copy (src/mocks/data.ts shareData).
import { AttachmentCard, Button, ChatHeader, ChatTranscript, ToolViewsProvider, defaultToolViews } from "agentic-ui-kit";
import { VisualsProvider, uiMarkupToolView, widgetToolView } from "agentic-ui-kit/visuals";
import type { ShareData } from "@slopbot/contracts";
import { useState } from "react";
import { ApiError, api } from "./api";
import { Logo } from "./logo";
import { AUTHOR, shareMessages } from "./share-data";
import { uiComponents } from "./ui-components";

/** The console's chat page keeps this ID through the sign-in, then continues the share (chat-page.tsx). */
const SHARE_KEY = "slopbot-share";
const WIDGET_HOST = { frameUrl: "/console/widget-frame.html" };
const toolViews = { ...defaultToolViews, show_ui: uiMarkupToolView(), show_widget: widgetToolView() };

/** The shared chat. "Continue in Slopbot" copies it into the viewer's own chat, after a sign-in if there is none. */
export function SharePage({ data }: { data: ShareData }) {
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
          renderPart={(part) => {
            if (part.type === "custom" && part.kind === AUTHOR) return <p className="text-sm font-medium text-chat-fg">{String(part.data)}</p>;
            // The kit draws only the viewer's own attachments; the shared bot messages need their cards drawn here.
            return part.type === "attachment" ? <AttachmentCard attachment={part} size="sm" /> : undefined;
          }}
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
