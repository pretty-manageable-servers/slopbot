import "agentic-ui-kit/styles.css";
import "./theme.css";
import { ChatTheme } from "agentic-ui-kit";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, api, loadSession, type ChatSummary, type Session } from "./api";
import { Chat } from "./chat";

const BASE = "/console/next";
const routeChat = () => /^\/console\/next\/chat\/([^/]+)\/?$/.exec(location.pathname)?.[1];

// The brand and the kit default to dark. Light follows the system setting until the theme setting is ported.
const light = matchMedia("(prefers-color-scheme: light)");
const applyTheme = () => {
  if (light.matches) document.documentElement.dataset.chatTheme = "light";
  else delete document.documentElement.dataset.chatTheme;
};
applyTheme();
light.addEventListener("change", applyTheme);

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState(routeChat);
  const [error, setError] = useState<{ text: string; signIn: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      const found = await loadSession();
      setSession(found);
      const list = await api.chats();
      setChats(list);
      // Without a chat in the address, open the newest chat.
      if (!routeChat() && list[0]) {
        history.replaceState(null, "", `${BASE}/chat/${list[0].id}`);
        setChatId(list[0].id);
      }
    })().catch((e: Error) => setError({ text: e.message, signIn: e instanceof ApiError && e.status === 401 }));
  }, []);

  if (error) {
    return (
      <div className="page-note">
        <p>{error.text}</p>
        {error.signIn && <a href="/auth/login">Sign in with Discord</a>}
      </div>
    );
  }
  if (!session) return <div className="page-note" aria-busy="true" />;
  const server = session.servers[0];
  if (!server) return <div className="page-note"><p>You and Slopbot need to share a Discord server to chat.</p></div>;

  const create = async () => {
    const { id } = await api.createChat(server.id);
    history.replaceState(null, "", `${BASE}/chat/${id}`);
    setChatId(id);
    return id;
  };
  return <Chat key={chatId ?? "new"} id={chatId} title={chats.find((c) => c.id === chatId)?.title ?? ""} onCreate={create} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatTheme className="app">
      <App />
    </ChatTheme>
  </StrictMode>,
);
