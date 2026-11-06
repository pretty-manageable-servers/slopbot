// The page frame: the kit's AppShell with the drawer on the left and the page on the right, plus Settings, the
// command palette and the notices over them. The drawer's top bar switches between Chats and Servers, as claude.ai
// switches between Chat and Code. The mode follows the page: chat pages are Chats, server pages are Servers.
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { AppShell, ChatList, ChatTitleMenu, Menu, MenuItem, MenuSeparator, SegmentedControl, Sidebar, SidebarItem, SidebarUser, defaultIcons } from "agentic-ui-kit";
import { Suspense, useEffect } from "react";
import { ApiError, api } from "./api";
import { chatsQuery, pickServer, sessionQuery, useServer } from "./data";
import { Loader, Logo } from "./logo";
import { CommandPalette } from "./palette";
import { BASE } from "./router";
import { ServersPane } from "./servers/pane";
import { SettingsDialog, useOpenSettings } from "./settings/dialog";
import { FeedbackHost, confirmAction, notifyError } from "./ui/feedback";
import { icons } from "./ui/icons";

const busy = <div className="page-note" aria-busy="true"><Loader size={56} /></div>;

export function Layout() {
  const session = useQuery(sessionQuery);
  if (session.error) {
    const signIn = session.error instanceof ApiError && session.error.status === 401;
    return (
      <div className="page-note">
        <p>{session.error.message}</p>
        {signIn && <a href="/auth/login">Sign in with Discord</a>}
      </div>
    );
  }
  if (!session.data) return busy;
  if (!session.data.servers.length) return <div className="page-note"><p>You and Slopbot need to share a Discord server to chat.</p></div>;
  return (
    <Suspense fallback={busy}>
      <Shell />
    </Suspense>
  );
}

function Shell() {
  const { data: session } = useSuspenseQuery(sessionQuery);
  const server = useServer();
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const openSettings = useOpenSettings();
  const serverPage = matchRoute({ to: "/server/$serverId", fuzzy: true }) as { serverId?: string } | false;
  const mode = serverPage ? "servers" : "chats";

  // A link to another server's page picks that server.
  useEffect(() => {
    if (serverPage && serverPage.serverId && serverPage.serverId !== server.id && session.servers.some((s) => s.id === serverPage.serverId)) pickServer(serverPage.serverId);
  }, [serverPage && serverPage.serverId]);

  const sidebar = (
    <Sidebar
      brand="Slopbot"
      brandIcon={<Logo size={22} />}
      headerActions={
        <SegmentedControl label="View" value={mode}
          options={[{ id: "chats", label: "Chats", icon: icons.chats, iconOnly: true }, { id: "servers", label: "Servers", icon: icons.server, iconOnly: true }]}
          onChange={(next: string) => void (next === "servers" ? navigate({ to: "/server/$serverId", params: { serverId: server.id } }) : navigate({ to: "/" }))} />
      }
      nav={mode === "chats" ? <NewChat /> : undefined}
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
              <MenuItem id="logout" onAction={() => void api.logout().then(() => location.reload(), notifyError)}>Log out</MenuItem>
            </Menu>
          }
        />
      }
    >
      <Suspense fallback={null}>{mode === "chats" ? <Chats /> : <ServersPane />}</Suspense>
    </Sidebar>
  );
  return (
    <>
      <AppShell sidebar={sidebar}>
        <Suspense fallback={busy}><Outlet /></Suspense>
      </AppShell>
      <SettingsDialog />
      <CommandPalette />
      <FeedbackHost />
    </>
  );
}

function NewChat() {
  const navigate = useNavigate();
  const onNew = !!useMatchRoute()({ to: "/" });
  return <SidebarItem icon={defaultIcons.edit} label="New chat" active={onNew} onPress={() => void navigate({ to: "/" })} />;
}

/** All private chats of the user, from every server, newest first, with rename and delete. */
function Chats() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data: chats } = useSuspenseQuery(chatsQuery);
  const open = useMatchRoute()({ to: "/chat/$chatId" }) as { chatId?: string } | false;
  const activeId = open ? open.chatId : undefined;
  const refresh = () => void client.invalidateQueries({ queryKey: chatsQuery.queryKey });

  const remove = async (id: string) => {
    if (!(await confirmAction({ title: "Delete this chat?", body: "This cannot be undone.", confirmLabel: "Delete", danger: true }))) return;
    await api.remove(id).catch(notifyError);
    if (id === activeId) void navigate({ to: "/" });
    refresh();
  };
  const rename = async (chat: { id: string; title: string }) => {
    const title = prompt("Rename chat", chat.title)?.trim();
    if (!title || title === chat.title) return;
    await api.update(chat.id, { title }).catch(notifyError);
    refresh();
  };
  return (
    <ChatList
      aria-label="Chats"
      sections={[{ id: "chats", title: "Chats", items: chats.map((c) => ({ id: c.id, title: c.title || "New chat", href: `${BASE}/chat/${c.id}` })) }]}
      {...(activeId && { activeId })}
      onSelect={(id) => void navigate({ to: "/chat/$chatId", params: { chatId: id } })}
      rowMenu={(chat) => <ChatTitleMenu onRename={() => void rename(chat)} onDelete={() => void remove(chat.id)} />}
    />
  );
}
