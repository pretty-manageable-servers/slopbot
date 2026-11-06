// One private chat on screen: the saved messages, then the bot's live stream folded into kit messages.
import { AttachButton, AttachmentRow, Button, ChatHeader, ChatTitleMenu, ChatView, DictationButton, EmptyState, Menu, MenuItem, ModelPicker, SidebarToggle, ToolViewsProvider, defaultToolViews, useAttachments } from "agentic-ui-kit";
import { VisualsProvider, uiMarkupToolView, widgetToolView } from "agentic-ui-kit/visuals";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useServer } from "./data";
import { attachmentIds, attachmentKind, attachmentProblem } from "./chat/attachments";
import { ShareDialog } from "./chat/share-dialog";
import { UsageMeter } from "./chat/usage-meter";
import type { EngineEnvelope } from "@slopbot/contracts";
import { applyEngineEvent, chatMessages, emptyChat, pendingSend, repliesOf, runTurnsOf, toKitMessage, withPending, type PendingSend, type BotMessage, type ChatState, type TurnSource } from "./events";
import { useTurns } from "./use-turns";
import { Loader, Logo } from "./logo";
import { useConsoleDictation } from "./ui/dictation";
import { usePausedComposer } from "./llm-status";
import { notify, notifyError } from "./ui/feedback";
import { uiComponents } from "./ui-components";

/** show_widget frames load the bot's frame page (WIDGET_FRAME_PATH in src/web-console.ts), outside the page CSP. */
const WIDGET_HOST = { frameUrl: "/console/widget-frame.html" };
const toolViews = { ...defaultToolViews, show_ui: uiMarkupToolView(), show_widget: widgetToolView() };
const ASK_WARNING = "Only send what you wrote yourself. A prompt from someone else can make Slopbot use tools or read data you did not mean to share.";

/** The question of a link, waiting in its chat's composer until it is sent or cleared. Kept for the page's life. */
export const linkedAsks = new Map<string, string>();
/** The send that is not on the page yet, by chat. A new chat's page reads it when it opens. */
const pendingSends = new Map<string, PendingSend>();

/** A new chat has no turns to load. */
const NO_TURNS: TurnSource = { turnEvents: async () => [] };

/** The one model for now. Its effort levels are the bot's (EFFORTS in src/domain.ts). */
const MODELS = [{
  id: "pangaea",
  label: "Pangaea",
  description: "For your everyday tasks",
  efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium", recommended: true }, { id: "xhigh", label: "Extra" }],
  defaultEffort: "medium",
}];

/** Uploads one file to the route of its kind. Resolves to the id the message sends. */
const uploadAttachment = (chat: string, file: File) => (attachmentKind(file.type) === "image"
  ? api.uploadImage(chat, file).then((image) => image.imageId)
  : api.uploadFile(chat, file).then((saved) => saved.fileId));
/** Deletes an uploaded attachment on the server. Used when it is removed before the send. */
const deleteAttachment = (chat: string, mime: string, id: string) => (attachmentKind(mime) === "image"
  ? api.removeImage(chat, id)
  : api.removeFile(chat, id));

interface ChatProps {
  id: string | undefined;
  title: string;
  effort: string;
  onEffort: (effort: string) => void;
  /** Makes the chat for a new composer. It is called once, on the first attachment or the first send. */
  onCreate: () => Promise<string>;
  /** After a message is sent. A new chat's page opens on `chatId` then. */
  onSent: (chatId: string) => void;
}

export function Chat({ id, title, effort, onEffort, onCreate, onSent }: ChatProps) {
  const server = useServer();
  const [pending, setPending] = useState(() => (id ? pendingSends.get(id) : undefined));
  // A new chat's first send shows at once, not after a loader.
  const [state, setState] = useState<ChatState | null>(id && !pending ? null : emptyChat());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [sharing, setSharing] = useState<string | null>(null);
  // The Share popover opens under the header's Share button, also from the title menu.
  const shareButton = useRef<HTMLSpanElement>(null);
  const [sending, setSending] = useState(false);
  const [ask, setAsk] = useState(() => (id ? linkedAsks.get(id) : undefined));
  const [draft, setDraft] = useState(ask ?? "");
  const dictation = useConsoleDictation();
  const paused = usePausedComposer();
  const fileInput = useRef<HTMLInputElement>(null);
  const made = useRef<Promise<string> | null>(null);

  useEffect(() => {
    if (!id) return;
    let source: EventSource | undefined, closed = false;
    const open = async () => {
      const page = await api.messages(id);
      if (closed) return;
      const messages = page.messages as BotMessage[];
      setState(emptyChat(messages.map((m) => toKitMessage(m, id)), repliesOf(messages), runTurnsOf(messages)));
      // Live engine events from the newest on. The steps of earlier replies are loaded by useTurns.
      source = new EventSource(api.eventsUrl(id));
      source.addEventListener("engine", (event) => {
        let envelope: EngineEnvelope;
        try { envelope = JSON.parse((event as MessageEvent<string>).data) as EngineEnvelope; } catch { return; }
        setState((s) => (s ? applyEngineEvent(s, envelope, id) : s));
      });
      source.addEventListener("closed", () => { source?.close(); setStatus("Live updates stopped. Reload to check again."); });
      source.onopen = () => setStatus("");
      source.onerror = () => setStatus(source?.readyState === EventSource.CLOSED ? "Disconnected." : "Reconnecting…");
    };
    open().catch((e: Error) => setError(e.message));
    return () => { closed = true; source?.close(); };
  }, [id]);

  const turnSource = useMemo<TurnSource | undefined>(() => (id ? {
    turnEvents: (turn) => api.turnEvents(id, turn).then((found) => found.events),
  } : undefined), [id]);
  useTurns(state, setState, turnSource ?? NO_TURNS);

  const saved = useMemo(() => (state ? chatMessages(state) : []), [state]);
  const shown = useMemo(() => withPending(saved, pending), [saved, pending]);
  const messages = shown.messages;
  const busy = messages.some((m) => m.status === "streaming");
  useEffect(() => {
    if (!shown.done) return;
    if (id) pendingSends.delete(id);
    setPending(undefined);
  }, [shown.done, id]);

  // A new composer makes its chat once, when the first file uploads or the first message sends.
  const ensureChat = (): Promise<string> => {
    if (id) return Promise.resolve(id);
    if (!made.current) made.current = onCreate().catch((e: unknown) => { made.current = null; throw e; });
    return made.current;
  };

  const attachments = useAttachments({
    upload: async (file, signal) => {
      const chat = await ensureChat();
      const fileId = await uploadAttachment(chat, file);
      // The draft was removed while it uploaded: the file is not wanted.
      if (signal.aborted) void deleteAttachment(chat, file.type, fileId).catch(() => {});
      return { fileId };
    },
  });

  const addFiles = (files: File[]) => {
    const accepted: File[] = [];
    for (const file of files) {
      const problem = attachmentProblem(file, attachments.attachments.length + accepted.length);
      if (problem) notify(problem, "error");
      else accepted.push(file);
    }
    attachments.addFiles(accepted);
  };

  const removeAttachment = (draftId: string) => {
    const draft = attachments.attachments.find((a) => a.id === draftId);
    attachments.remove(draftId);
    if (draft?.fileId) void ensureChat().then((chat) => deleteAttachment(chat, draft.mime, draft.fileId!)).catch(() => {});
  };

  const clearAsk = () => {
    if (id) linkedAsks.delete(id);
    setAsk(undefined);
  };

  const send = (text: string) => {
    const { images, files } = attachmentIds(attachments.attachments);
    clearAsk();
    setSending(true);
    const sent = pendingSend(text, attachments.attachments, saved.length);
    setPending(sent);
    let chat: string | undefined;
    void (async () => {
      chat = await ensureChat();
      pendingSends.set(chat, sent);
      await api.send(chat, text, images, files);
      attachments.clear();
      onSent(chat);
    })().catch((e: Error) => {
      // The text comes back when the field is still empty. The attachments stay for a retry.
      setDraft((current) => current || text);
      if (chat) pendingSends.delete(chat);
      setPending(undefined);
      notifyError(e);
    }).finally(() => setSending(false));
  };

  if (error) return <div className="page-note"><p>{error}</p></div>;
  if (!state) return <div className="page-note" aria-busy="true"><Loader size={56} /></div>;
  return (
    <VisualsProvider components={uiComponents} host={WIDGET_HOST}>
    <ToolViewsProvider tools={toolViews}>
    <ChatView
      messages={messages}
      busy={busy}
      onSend={send}
      onStop={id ? () => void api.stop(id).catch((e: Error) => setError(e.message)) : undefined}
      header={
        <ChatHeader
          leading={<SidebarToggle drawerOnly />}
          title={messages.length ? title || "New chat" : ""}
          menu={id && messages.length ? <ChatTitleMenu onShare={() => setSharing(id)} /> : undefined}
          actions={(status || (id && messages.length)) ? (
            <>
              {status && <span role="status">{status}</span>}
              {id && messages.length > 0 && <span ref={shareButton} className="inline-flex"><Button variant="ghost" size="sm" onPress={() => setSharing(id)}>Share</Button></span>}
            </>
          ) : undefined}
        />
      }
      composer={{
        isDisabled: paused.isDisabled,
        placeholder: messages.length ? "Reply to Slopbot…" : "How can I help you today?",
        value: draft,
        onChange: (text) => {
          setDraft(text);
          if (ask !== undefined && !text.trim()) clearAsk();
        },
        allowEmpty: attachments.attachments.length > 0,
        submitDisabled: attachments.uploading || sending,
        onFiles: addFiles,
        leading: (
          <>
            <AttachButton label="Attach">
              <Menu aria-label="Add to this message">
                <MenuItem id="files" onAction={() => fileInput.current?.click()}>Add images or files</MenuItem>
              </Menu>
            </AttachButton>
            <UsageMeter server={server.id} busy={busy} />
          </>
        ),
        above: (
          <>
            {paused.above}
            {ask !== undefined && (
              <div role="alert" className="mb-2 rounded-chat-sm bg-chat-warning-bg px-3 py-2 text-sm text-chat-fg">
                <strong className="font-medium">This question came from a link. Read it before you send it.</strong> {ASK_WARNING}
              </div>
            )}
            <AttachmentRow attachments={attachments.attachments} onRemove={removeAttachment} />
          </>
        ),
        dictation: dictation.state,
        trailing: (
          <>
            {dictation.supported && <DictationButton onPress={dictation.start} />}
            <ModelPicker models={MODELS} model="pangaea" onModelChange={() => {}} effort={effort} onEffortChange={onEffort} effortNote="More effort thinks longer and uses more of your limit." />
          </>
        ),
      }}
      emptyState={(composer) => <EmptyState icon={<Logo size={40} />} greeting="What can Slopbot do for you?">{composer}</EmptyState>}
      disclaimer="Slopbot can make mistakes. Check important answers."
    />
    <input
      ref={fileInput}
      type="file"
      multiple
      hidden
      onChange={(event) => {
        addFiles(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }}
    />
    <ShareDialog chatId={sharing} triggerRef={shareButton} onClose={() => setSharing(null)} />
    </ToolViewsProvider>
    </VisualsProvider>
  );
}
