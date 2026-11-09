// The drawer in the Servers view: the server picker, the server's Inbox, then its channels and threads.
import { useQuery } from "@tanstack/react-query";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { ChatList, SidebarItem } from "agentic-ui-kit";
import { useServer } from "../data";
import { BASE } from "../router";
import { icons } from "../ui/icons";
import { SectionNote } from "../ui/layout";
import { ServerPicker } from "./picker";
import { conversationsQuery, inboxQuery } from "./queries";
import { serverSections } from "./tree";

/** The drawer content of the Servers view: the picker, the Inbox row (with the open count), channels and threads. */
export function ServersPane() {
  const server = useServer();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const conversations = useQuery(conversationsQuery(server.id));
  const inbox = useQuery(inboxQuery(server.id, false));

  const onInbox = !!matchRoute({ to: "/server/$serverId" });
  const open = matchRoute({ to: "/server/$serverId/channel/$channelId" }) as { channelId?: string } | false;
  const activeId = open ? open.channelId : undefined;

  const count = inbox.data?.length ?? 0;
  const sections = conversations.data ? serverSections(conversations.data, (c) => `${BASE}/server/${server.id}/channel/${c.id}`) : [];

  return (
    <div className="flex flex-col gap-1 px-2">
      <ServerPicker />
      {/* SidebarItem is an <li>; outside the Sidebar's nav slot it needs its own list. */}
      <ul className="m-0 list-none p-0">
        <SidebarItem icon={icons.inbox} label={count ? `Inbox (${count >= 50 ? "50+" : count})` : "Inbox"} active={onInbox}
          onPress={() => void navigate({ to: "/server/$serverId", params: { serverId: server.id } })} />
      </ul>
      {conversations.error
        ? <SectionNote>The channels are not available right now.</SectionNote>
        : conversations.data && !sections.length
          ? <SectionNote>Nothing to show yet.</SectionNote>
          : <ChatList aria-label="Channels and threads" sections={sections} {...(activeId && { activeId })} />}
    </div>
  );
}
