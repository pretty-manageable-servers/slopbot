// A private chat page: the chat with its effort. A new chat (no id) is made on the first attachment or send, in the
// picked server, and the page opens on it after the first send. The old console's links open here too: a question
// in the hash (#ask=<text>) and a shared chat to continue.
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { Chat, linkedAsks } from "./chat";
import { chatsQuery, useServer } from "./data";
import { notifyError } from "./ui/feedback";

const ASK_KEY = "slopbot-ask";
/** Longest question the chat API takes. It matches PRIVATE_CHAT_MAX_CHARS in src/private-chat.ts. */
const ASK_MAX_CHARS = 8000;
/** Set by the shared page for a signed-out viewer who presses Continue, before the sign-in. */
const SHARE_KEY = "slopbot-share";

/**
 * Moves the question in the hash (#ask=…) to sessionStorage and removes the hash. main.tsx calls it before the
 * session loads, so a signed-out visitor keeps the question over the Discord sign-in.
 */
export function stashAsk() {
  const match = /^#ask=(.*)$/s.exec(location.hash);
  if (!match) return;
  let text = "";
  try { text = decodeURIComponent(match[1]!); } catch { text = ""; }
  history.replaceState(history.state, "", location.pathname + location.search);
  try { if (text.trim()) sessionStorage.setItem(ASK_KEY, text); } catch { /* private mode: lost on sign-in */ }
  if (text.trim()) pendingAsk = text;
}
let pendingAsk = "";

/** The stashed question, cut to the bot's limit. */
function takeAsk(): string {
  let text = pendingAsk;
  pendingAsk = "";
  if (!text) try { text = sessionStorage.getItem(ASK_KEY) || ""; } catch { /* no storage */ }
  return [...text.trim()].slice(0, ASK_MAX_CHARS).join("");
}

/** A failed call as a notice. A 404 gets the page's own words. */
const failed = (error: unknown, gone: string) => notifyError(error instanceof ApiError && error.status === 404 ? new Error(gone) : error);

export function ChatPage({ id }: { id?: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const server = useServer();
  const { data: chats } = useSuspenseQuery(chatsQuery);
  // The effort for a chat that does not exist yet. It is saved on the chat when the chat is made.
  const [draftEffort, setDraftEffort] = useState("medium");
  // The chat this composer made, once the first file or message made it. The page still has no id until the send
  // finishes, so a pick in that time goes to this chat, not only to the draft.
  const madeId = useRef<string | null>(null);
  const draftRef = useRef(draftEffort);
  // Leaving a chat for a new one: picks there are for the next chat.
  useEffect(() => {
    if (!id) madeId.current = null;
  }, [id]);
  const current = chats.find((c) => c.id === id);
  const refresh = () => void client.invalidateQueries({ queryKey: chatsQuery.queryKey });
  const open = (chatId: string) => void navigate({ to: "/chat/$chatId", params: { chatId }, replace: true });

  // The question opens a new chat with its text in the composer. It is not sent: the chat warns the user to read it first.
  const askFromLink = async () => {
    const text = takeAsk();
    if (!text) return;
    try { sessionStorage.removeItem(ASK_KEY); } catch { /* no storage */ }
    try {
      const { id: made } = await api.createChat(server.id);
      linkedAsks.set(made, text);
      refresh();
      void navigate({ to: "/chat/$chatId", params: { chatId: made }, replace: true });
    } catch (error) {
      failed(error, "Private chats are not available right now.");
    }
  };

  // The shared chat is copied into a new chat, which opens.
  const continueShare = async () => {
    let shareId = "";
    try { shareId = sessionStorage.getItem(SHARE_KEY) || ""; sessionStorage.removeItem(SHARE_KEY); } catch { /* no storage */ }
    if (!/^[A-Za-z0-9_-]{22}$/.test(shareId)) return;
    try {
      const chat = await api.continueShare(shareId);
      refresh();
      void navigate({ to: "/chat/$chatId", params: { chatId: chat.id } });
    } catch (error) {
      failed(error, "That shared chat is no longer available.");
    }
  };

  // Both take what they read out of storage or the hash before they wait on the network, so a second run finds nothing.
  useEffect(() => {
    void askFromLink();
    void continueShare();
  }, []);

  const create = async () => {
    const { id: made } = await api.createChat(server.id);
    madeId.current = made;
    // The ref, not the state: the pick can change while the chat is made.
    if (draftRef.current !== "medium") await api.update(made, { effort: draftRef.current }).catch(() => {});
    refresh();
    return made;
  };
  const sent = (chatId: string) => {
    if (!id) open(chatId);
    refresh();
  };
  const setEffort = (effort: string) => {
    if (!id) {
      draftRef.current = effort;
      setDraftEffort(effort);
    }
    const chatId = id ?? madeId.current;
    if (!chatId) return;
    client.setQueryData(chatsQuery.queryKey, (list) => list?.map((c) => (c.id === chatId ? { ...c, effort: effort as typeof c.effort } : c)));
    api.update(chatId, { effort }).catch(refresh);
  };

  return <Chat key={id ?? "new"} id={id} title={current?.title ?? ""} effort={id ? current?.effort ?? "medium" : draftEffort} onEffort={setEffort} onCreate={create} onSent={sent} />;
}
