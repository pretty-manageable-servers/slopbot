// /server/$serverId/channel/$channelId: one channel's or thread's transcript, read-only, with live updates. ?run=<id>
// shows one of its conversations. The reply box is under the channel when the user can send. The bot's routes:
// src/web-transcripts.ts (the conversation list, messages, stream, runs and reply).
import { useMutation, useQueries, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AttachmentCard, Button, ChatHeader, ChatTranscript, Drawer, DRAWER_QUERY, SidebarToggle, useMediaQuery } from "agentic-ui-kit";
import type { Part } from "agentic-ui-kit/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, get, post, qs } from "../api";
import type { ChannelHeader, Conversation, ConversationSummary, TranscriptMessage, TranscriptPage } from "../api-types";
import { chatMessages, emptyChat, type ChatState, type RunStep } from "../events";
import { sessionQuery } from "../data";
import { Loader, Logo } from "../logo";
import { channelRoute } from "../router";
import { notify, notifyError } from "../ui/feedback";
import { ReplyBox } from "./reply-box";
import { conversationsQuery } from "./queries";
import { RunsPanel } from "./runs";
import { ShareChannelDialog } from "./share-channel";
import { applyTranscriptEvent, channelMessage, displayMessages, foldOfPart, foldUnused, markUsed, metaOfPart, unusedIds, runIdsOf, type FoldRow, type Meta, type TranscriptEvent } from "./transcript";

const KINDS = ["message", "run.start", "run.delta", "run.tool", "run.end"] as const;
/** Messages per request. The bot's limit is 100. */
const PAGE = 50;

/** One conversation (GET .../runs/:runId): the channel, the conversation and its messages. */
interface RunPage extends ChannelHeader {
  streamId: number;
  conversation: ConversationSummary & { runIds: string[] };
  hasMore: boolean;
  messages: TranscriptMessage[];
}

export function ChannelPage() {
  const { serverId, channelId } = channelRoute.useParams();
  const { run } = channelRoute.useSearch();
  const { data: session } = useSuspenseQuery(sessionQuery);
  // The conversation list says whether web transcripts are on for the channel. The messages route only refuses.
  const list = useQuery(conversationsQuery(serverId));
  if (list.isPending) return <div className="page-note" aria-busy="true"><Loader size={56} /></div>;
  const listed = list.data?.find((item) => item.id === channelId);
  if (listed?.enabled === false) {
    const admin = session.servers.find((server) => server.id === serverId)?.admin === true;
    return <OffNote server={serverId} channel={channelId} title={`#${listed.name}`} admin={admin} />;
  }
  return <Transcript serverId={serverId} channelId={channelId} run={run} user={session.user} />;
}

/** Shown instead of the messages when web transcripts are off for the channel. Admins can turn them on. */
function OffNote({ server, channel, title, admin }: { server: string; channel: string; title: string; admin: boolean }) {
  const client = useQueryClient();
  const turnOn = useMutation({
    mutationFn: () => post("/api/web-transcripts/channels", { server, channel, enabled: true }),
    onSuccess: () => {
      notify("Web transcripts on for this channel.");
      void client.invalidateQueries({ queryKey: conversationsQuery(server).queryKey });
    },
    onError: (error) => notifyError(error),
  });
  return (
    <div className="flex h-full min-h-0 flex-col bg-chat-bg text-chat-fg">
      <ChatHeader leading={<SidebarToggle drawerOnly />} title={title} />
      <div className="page-note flex-1">
        <h2 className="font-medium text-chat-fg">Web transcripts are off for this channel.</h2>
        {admin
          ? <Button variant="primary" isDisabled={turnOn.isPending} onPress={() => turnOn.mutate()}>Turn on web transcripts</Button>
          : <p>A server admin can turn them on.</p>}
      </div>
    </div>
  );
}

function Transcript({ serverId, channelId, run, user }: { serverId: string; channelId: string; run: string | undefined; user: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [panel, setPanel] = useState(false);
  const [state, setState] = useState<ChatState | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [sharing, setSharing] = useState(false);
  const [shownFolds, setShownFolds] = useState<ReadonlySet<string>>(() => new Set());
  const phone = useMediaQuery(DRAWER_QUERY);
  const scope = ["conversations", serverId, channelId];
  const base = `/api/conversations/${encodeURIComponent(channelId)}`;

  const newest = useQuery({
    queryKey: [...scope, "messages"],
    queryFn: () => get<TranscriptPage>(`${base}/messages${qs({ server: serverId, limit: PAGE })}`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const conversation = useQuery({
    queryKey: [...scope, "run", run],
    queryFn: () => get<RunPage>(`${base}/runs/${encodeURIComponent(run ?? "")}${qs({ server: serverId })}`),
    enabled: run !== undefined,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // The newest page starts the page. A reload of it (after a reset) starts over.
  useEffect(() => {
    if (!newest.data) return;
    setState(emptyChat(newest.data.messages.map((message) => channelMessage(message, user, channelId)), newest.data.streamId));
    setHasMore(newest.data.hasMore);
  }, [newest.data, user, channelId]);

  // Live events from after the page. A reloaded page (after a reset) reopens the stream.
  const after = newest.data?.streamId;
  const loaded = newest.dataUpdatedAt;
  // After a run ends, other people's messages are checked again: a reply run may have used them now.
  const refreshUsed = () => {
    const ids = unusedIds(stateRef.current?.saved ?? []);
    if (!ids.length) return;
    get<{ used: string[] }>(`${base}/used${qs({ server: serverId, ids: ids.join(",") })}`)
      .then(({ used }) => setState((s) => s && { ...s, saved: markUsed(s.saved, new Set(used)) }))
      .catch(() => { /* the folds stay as they are */ });
  };
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (after === undefined) return;
    const source = new EventSource(`${base}/stream${qs({ server: serverId, after })}`);
    for (const type of KINDS) {
      source.addEventListener(type, (event) => {
        const message = event as MessageEvent<string>;
        let data: unknown;
        try { data = JSON.parse(message.data); } catch { return; }
        const bot = { type, id: Number(message.lastEventId) || 0, data } as TranscriptEvent;
        setState((s) => (s ? applyTranscriptEvent(s, bot, channelId, user) : s));
        // A new message or a finished run can change the conversations and the open conversation.
        if (type === "message" || type === "run.end") {
          if (type === "run.end" || (data as { message?: { slopbot?: boolean } }).message?.slopbot) refreshUsed();
          void client.invalidateQueries({ queryKey: [...scope, "runs"] });
          void client.invalidateQueries({ queryKey: [...scope, "run"] });
        }
      });
    }
    source.addEventListener("reset", () => {
      source.close();
      void client.invalidateQueries({ queryKey: [...scope, "messages"] });
    });
    source.addEventListener("closed", (event) => {
      source.close();
      let reason = "access";
      try { reason = JSON.parse((event as MessageEvent<string>).data).reason; } catch { /* keep the default */ }
      setStatus(reason === "access" ? "Access ended. Reload to check again." : "Live updates stopped.");
    });
    source.onopen = () => setStatus("");
    source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? "Disconnected." : "Reconnecting…");
    return () => source.close();
  }, [serverId, channelId, after, loaded, user]);

  const channel = newest.data?.channel;
  const canSend = run === undefined && newest.data?.canSend === true;
  const shown = useMemo(() => {
    if (run !== undefined) return conversation.data?.messages.map((message) => channelMessage(message, user, channelId)) ?? [];
    return state ? chatMessages(state) : [];
  }, [run, conversation.data, state, user, channelId]);
  const steps = useRunSteps(serverId, channelId, useMemo(() => runIdsOf(shown), [shown]));
  const messages = useMemo(() => foldUnused(displayMessages(shown, steps), Object.keys(state?.live ?? {}), shownFolds), [shown, steps, state, shownFolds]);
  const toggleFold = useCallback((key: string) => {
    setShownFolds((keys) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const renderRow = useCallback((part: Part) => renderPart(part, toggleFold), [toggleFold]);

  const oldest = state?.saved[0]?.id;
  const loadOlder = async () => {
    if (!oldest) return;
    setOlderBusy(true);
    try {
      const page = await get<TranscriptPage>(`${base}/messages${qs({ server: serverId, limit: PAGE, before: oldest })}`);
      setState((s) => s && { ...s, saved: [...page.messages.map((message) => channelMessage(message, user, channelId)), ...s.saved] });
      setHasMore(page.hasMore);
    } catch (error) {
      notifyError(error);
    } finally {
      setOlderBusy(false);
    }
  };

  const error = newest.error ?? (run !== undefined ? conversation.error : null);
  if (error) return <div className="page-note"><p>{error.message}</p></div>;
  if (!state || !channel) return <div className="page-note" aria-busy="true"><Loader size={56} /></div>;

  const name = `${channel.parent ? "" : "#"}${channel.name}`;
  const runTitle = run !== undefined ? conversation.data?.conversation.title : undefined;
  const notice = (
    <div className="flex flex-col items-center gap-2 text-chat-muted">
      {run === undefined && hasMore && <Button variant="ghost" size="sm" isDisabled={olderBusy} onPress={() => void loadOlder()}>Load older messages</Button>}
      {run === undefined && messages.length === 0 && <p>No messages yet.</p>}
      {run !== undefined && (
        <div className="flex w-full items-center justify-between gap-3">
          <span>Conversation{runTitle ? `: ${runTitle}` : ""}</span>
          <Button variant="outline" size="sm" onPress={() => void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, run: undefined }) })}>Back to channel</Button>
        </div>
      )}
    </div>
  );
  // Sharing stays on the whole channel, so it is not offered in a conversation (the old console's rule).
  const actions = (
    <div className="flex items-center gap-2">
      {status && <span role="status" className="text-(length:--chat-ui-font-size-sm) text-chat-muted">{status}</span>}
      {run === undefined && newest.data?.canShare === true && <Button variant="ghost" size="sm" onPress={() => setSharing(true)}>Share</Button>}
      <Button variant="ghost" size="sm" aria-expanded={panel} onPress={() => setPanel((open) => !open)}>Conversations</Button>
    </div>
  );
  const runs = (className: string) => <RunsPanel server={serverId} channel={channelId} active={run} onClose={() => setPanel(false)} className={className} />;
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <ChatTranscript
        className="min-w-0 flex-1"
        start="bottom"
        header={<ChatHeader leading={<SidebarToggle drawerOnly />} title={runTitle ? `${name} · ${runTitle}` : name} actions={actions} />}
        notice={notice}
        messages={messages}
        renderPart={renderRow}
        footer={canSend ? <ReplyBox server={serverId} channel={channelId} /> : undefined}
      />
      {panel && !phone && runs("w-80 shrink-0 border-l border-chat-border")}
      <Drawer side="right" isOpen={panel && phone} onOpenChange={setPanel}>{runs("h-full w-80 max-w-full")}</Drawer>
      <ShareChannelDialog server={serverId} channel={channelId} open={sharing} onClose={() => setSharing(false)} />
    </div>
  );
}

/** The steps of each run, loaded once per run (GET /api/runs/:runId). A run that fails to load gives no steps. */
function useRunSteps(serverId: string, channelId: string, runIds: string[]): Map<string, readonly RunStep[]> {
  const combine = useCallback((results: { data?: RunStep[] }[]) => new Map(runIds.map((id, index) => [id, results[index]?.data ?? []] as const)), [runIds]);
  return useQueries({
    queries: runIds.map((id) => ({
      queryKey: ["conversations", serverId, channelId, "steps", id],
      queryFn: () => api.run(id).then((run) => run.steps as RunStep[]),
      staleTime: Infinity,
    })),
    combine,
  });
}

/** The author line above a message, and the row of a folded run. The kit draws the viewer's own messages and their attachments itself. */
function renderPart(part: Part, toggleFold: (key: string) => void): ReactNode {
  const meta = metaOfPart(part);
  if (meta) return <AuthorLine meta={meta} />;
  const fold = foldOfPart(part);
  if (fold) return <FoldButton fold={fold} onToggle={toggleFold} />;
  if (part.type === "attachment") return <AttachmentCard attachment={part} size="sm" />;
  return undefined;
}

/** Messages from other people that no reply used, in one muted row. A press shows them, and a second press folds them again. */
function FoldButton({ fold, onToggle }: { fold: FoldRow; onToggle: (key: string) => void }) {
  return (
    <Button variant="ghost" size="sm" aria-expanded={fold.open} onPress={() => onToggle(fold.key)} className="self-start text-chat-muted">
      {`${fold.count} ${fold.count === 1 ? "message" : "messages"} Slopbot did not read ›`}
    </Button>
  );
}

function AuthorLine({ meta }: { meta: Meta }) {
  if (meta.continued) return null;
  return (
    <div className="mb-1 flex items-center gap-2 font-chat-sans text-(length:--chat-ui-font-size-sm) text-chat-muted">
      {meta.slopbot ? <Logo size={20} /> : <Avatar name={meta.name} src={meta.avatarUrl} />}
      <strong className="font-medium text-chat-fg" title={meta.username ? `@${meta.username}` : undefined}>{meta.name}</strong>
      {meta.edited && <span className="text-chat-subtle">edited</span>}
    </div>
  );
}

/** A person's avatar, or their initial when there is none or it does not load. */
function Avatar({ name, src }: { name: string; src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img src={src} alt="" width={24} height={24} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-6 rounded-full" />;
  }
  return <span aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-chat-surface">{Array.from(name)[0]?.toUpperCase() ?? "?"}</span>;
}
