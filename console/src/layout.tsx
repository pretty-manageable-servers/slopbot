// The page frame: the kit's AppShell with the drawer on the left and the page on the right, plus Settings, the
// command palette and the notices over them. The drawer's top bar switches between Chats and Servers, as claude.ai
// switches between Chat and Code. The mode follows the page: chat pages are Chats, server pages are Servers.
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { AppShell, ChatList, Menu, MenuItem, MenuSeparator, SidebarItem, defaultIcons } from "agentic-ui-kit";
import { SegmentedControl } from "slop-ui-components";
import { Pencil, Share, Trash2 } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { ShareDialog } from "./chat/share-dialog";
import { chatsQuery, pickServer, sessionQuery, useServer } from "./data";
import { LlmBanner } from "./llm-status";
import { Logo } from "./logo";
import { CommandPalette } from "./palette";
import { BASE } from "./router";
import { ServersPane } from "./servers/pane";
import { SettingsDialog, useOpenSettings } from "./settings/dialog";
import { FeedbackHost, confirmAction, notifyError } from "./ui/feedback";
import { AccountMenu } from "./ui/account-menu";
import { icons } from "./ui/icons";
import { PageLoading, PageNote } from "./ui/page-state";
import { Drawer } from "./ui/sidebar";

export function Layout() {
  const session = useQuery(sessionQuery);
  if (session.error) {
    const signIn = session.error instanceof ApiError && session.error.status === 401;
    return (
      <PageNote action={signIn && <a href="/auth/login">Sign in with Discord</a>}>{session.error.message}</PageNote>
    );
  }
  if (!session.data) return <PageLoading />;
  if (!session.data.servers.length) return <PageNote>You and Slopbot need to share a Discord server to chat.</PageNote>;
  return (
    <Suspense fallback={<PageLoading />}>
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
    <Drawer
      brand="Slopbot"
      logo={<Logo size={28} />}
      switcher={
        <SegmentedControl aria-label="View" value={mode} iconOnly size="sm"
          options={[{ id: "chats", label: "Chats", icon: icons.chats }, { id: "servers", label: "Servers", icon: icons.server }]}
          onChange={(next) => void (next === "servers" ? navigate({ to: "/server/$serverId", params: { serverId: server.id } }) : navigate({ to: "/" }))} />
      }
      nav={mode === "chats" ? <NewChat /> : undefined}
      footer={
        <AccountMenu
          name={session.me?.displayName ?? session.user}
          {...(session.me?.avatarUrl && { avatarUrl: session.me.avatarUrl })}
          onSettings={() => openSettings()}
          onLogout={() => void api.logout().then(() => location.reload(), notifyError)}
        />
      }
    >
      <Suspense fallback={null}>{mode === "chats" ? <Chats /> : <ServersPane />}</Suspense>
    </Drawer>
  );
  return (
    <>
      <AppShell sidebar={sidebar}>
        <LlmBanner />
        <Suspense fallback={<PageLoading />}><Outlet /></Suspense>
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
  const [sharing, setSharing] = useState<string | null>(null);

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
    <>
      <ChatList
        aria-label="Chats"
        sections={[{ id: "chats", title: "Chats", items: chats.map((c) => ({ id: c.id, title: c.title || "New chat", href: `${BASE}/chat/${c.id}` })) }]}
        {...(activeId && { activeId })}
        rowMenu={(chat) => (
          // The kit's row supplies the popover, so this is the kit's Menu.
          <Menu aria-label="Chat actions" className="min-w-56">
            <MenuItem icon={<Pencil />} onAction={() => void rename(chat)}>Rename</MenuItem>
            <MenuItem icon={<Share />} onAction={() => setSharing(chat.id)}>Share</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} tone="danger" onAction={() => void remove(chat.id)}>Delete</MenuItem>
          </Menu>
        )}
      />
      <ShareDialog chatId={sharing} onClose={() => setSharing(null)} />
    </>
  );
}
