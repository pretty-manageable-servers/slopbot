import "./app.css";
import { AppShell, Button, ChatList, ChatTheme, ChatTitleMenu, Menu, MenuItem, MenuSeparator, MenuTrigger, Popover, Sidebar, SidebarItem, SidebarUser, defaultIcons } from "agentic-ui-kit";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, api, loadSession, type ChatSummary, type Session } from "./api";
import { Chat } from "./chat";
import { Loader, Logo } from "./logo";
import "./prefs";
import { SettingsDialog, openSettings } from "./settings";

const BASE = "/console/next";
const routeChat = () => /^\/console\/next\/chat\/([^/]+)\/?$/.exec(location.pathname)?.[1];
const chatPath = (id: string | undefined) => (id ? `${BASE}/chat/${id}` : `${BASE}/`);

// The server for new chats. Kept per browser; the first shared server when unset or no longer shared.
const SERVER_KEY = "slopbot.server";
const savedServer = () => { try { return localStorage.getItem(SERVER_KEY) ?? undefined; } catch { return undefined; } };

const serverMark = (server: { name: string; icon: string | null }, size = 20) =>
  server.icon
    ? <img src={server.icon} alt="" width={size} height={size} className="shrink-0 rounded-md" referrerPolicy="no-referrer" />
    : <span aria-hidden="true" className="grid shrink-0 place-items-center rounded-md bg-chat-raised text-xs font-semibold" style={{ width: size, height: size }}>{server.name.slice(0, 1).toUpperCase()}</span>;

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState(routeChat);
  // The effort for a chat that does not exist yet. It is saved on the chat when the chat is made.
  const [draftEffort, setDraftEffort] = useState("medium");
  const [serverId, setServerId] = useState(savedServer);
  const [error, setError] = useState<{ text: string; signIn: boolean } | null>(null);

  const refresh = useCallback(() => api.chats().then(setChats, () => {}), []);

  useEffect(() => {
    (async () => {
      setSession(await loadSession());
      setChats(await api.chats());
    })().catch((e: Error) => setError({ text: e.message, signIn: e instanceof ApiError && e.status === 401 }));
    const back = () => setChatId(routeChat());
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);

  if (error) {
    return (
      <div className="page-note">
        <p>{error.text}</p>
        {error.signIn && <a href="/auth/login">Sign in with Discord</a>}
      </div>
    );
  }
  if (!session) return <div className="page-note" aria-busy="true"><Loader size={56} /></div>;
  const server = session.servers.find((s) => s.id === serverId) ?? session.servers[0];
  if (!server) return <div className="page-note"><p>You and Slopbot need to share a Discord server to chat.</p></div>;

  const open = (id: string | undefined) => {
    if (id === chatId) return;
    history.pushState(null, "", chatPath(id));
    setChatId(id);
  };
  const create = async () => {
    const { id } = await api.createChat(server.id);
    if (draftEffort !== "medium") await api.update(id, { effort: draftEffort }).catch(() => {});
    history.replaceState(null, "", chatPath(id));
    setChatId(id);
    void refresh();
    return id;
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this chat?")) return;
    await api.remove(id).catch((e: Error) => alert(e.message));
    if (id === chatId) open(undefined);
    void refresh();
  };
  const rename = async (chat: { id: string; title: string }) => {
    const title = prompt("Rename chat", chat.title)?.trim();
    if (!title || title === chat.title) return;
    await api.update(chat.id, { title }).catch((e: Error) => alert(e.message));
    void refresh();
  };
  const current = chats.find((c) => c.id === chatId);
  const effort = chatId ? current?.effort || "medium" : draftEffort;
  const setEffort = (value: string) => {
    if (!chatId) return setDraftEffort(value);
    setChats((list) => list.map((c) => (c.id === chatId ? { ...c, effort: value } : c)));
    api.update(chatId, { effort: value }).catch(() => void refresh());
  };

  const pickServer = (id: string) => {
    setServerId(id);
    try { localStorage.setItem(SERVER_KEY, id); } catch { /* private mode: kept until reload */ }
  };
  const serverPicker = session.servers.length > 1 ? (
    <MenuTrigger>
      <Button variant="ghost" className="w-full justify-start gap-2" aria-label={`Server: ${server.name}`}>
        {serverMark(server)}
        <span className="min-w-0 flex-1 truncate text-left">{server.name}</span>
        {defaultIcons.dropdown}
      </Button>
      <Popover placement="bottom start">
        <Menu aria-label="Server for new chats" selectionMode="single" selectedKeys={[server.id]} onAction={(key) => pickServer(String(key))}>
          {session.servers.map((s) => <MenuItem key={s.id} id={s.id} icon={serverMark(s)}>{s.name}</MenuItem>)}
        </Menu>
      </Popover>
    </MenuTrigger>
  ) : (
    <div className="flex items-center gap-2 px-2 py-1.5">{serverMark(server)}<span className="truncate">{server.name}</span></div>
  );

  const sidebar = (
    <Sidebar
      brand={<span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}><Logo size={28} />Slopbot</span>}
      nav={<>
        {serverPicker}
        <SidebarItem icon={defaultIcons.edit} label="New chat" active={!chatId} onPress={() => open(undefined)} />
      </>}
      footer={
        <SidebarUser
          name={session.me?.displayName ?? session.user}
          {...(session.me?.avatarUrl && { avatarUrl: session.me.avatarUrl })}
          detail={server.name}
          menu={
            <Menu aria-label="Account">
              <MenuItem id="settings" onAction={() => openSettings()}>Settings</MenuItem>
              <MenuItem id="old" href="/console">Old console</MenuItem>
              <MenuSeparator />
              <MenuItem id="logout" onAction={() => void api.logout().then(() => location.reload())}>Log out</MenuItem>
            </Menu>
          }
        />
      }
    >
      <ChatList
        aria-label="Chats"
        sections={[{ id: "chats", title: "Chats", items: chats.map((c) => ({ id: c.id, title: c.title || "New chat", href: chatPath(c.id) })) }]}
        {...(chatId && { activeId: chatId })}
        onSelect={open}
        rowMenu={(chat) => <ChatTitleMenu onRename={() => void rename(chat)} onDelete={() => void remove(chat.id)} />}
      />
    </Sidebar>
  );
  return (
    <>
    <AppShell sidebar={sidebar}>
      <Chat key={chatId ?? "new"} id={chatId} title={current?.title ?? ""} effort={effort} onEffort={setEffort} onCreate={create} onSent={() => void refresh()} />
    </AppShell>
    <SettingsDialog />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatTheme className="contents">
      <App />
    </ChatTheme>
  </StrictMode>,
);
