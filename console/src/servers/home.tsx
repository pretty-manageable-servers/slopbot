// /server/$serverId: the server's Inbox, the page the Servers view opens on. The picked server is the one shown.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button, ChatHeader, SidebarToggle } from "agentic-ui-kit";
import { useState } from "react";
import { useServer } from "../data";
import { SectionNote } from "../ui/layout";
import { InboxList, useMarkInboxDone } from "./inbox";
import { inboxQuery } from "./queries";

/** The Inbox page of the picked server: its open items, Show done and Mark all done. */
export function ServerHome() {
  const server = useServer();
  const [showDone, setShowDone] = useState(false);
  const inbox = useQuery({ ...inboxQuery(server.id, showDone), placeholderData: keepPreviousData });
  const markDone = useMarkInboxDone(server.id);
  const hasOpen = inbox.data?.some((item) => !item.done_at) ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader
        leading={<SidebarToggle drawerOnly />}
        title="Inbox"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" aria-pressed={showDone} onPress={() => setShowDone(!showDone)}>Show done</Button>
            <Button variant="outline" size="sm" isDisabled={!hasOpen || markDone.isPending} onPress={() => markDone.mutate("all")}>Mark all done</Button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full px-4 pb-8" style={{ maxWidth: "var(--chat-content-width)" }}>
          {inbox.error
            ? <SectionNote>The inbox is not available right now.</SectionNote>
            : inbox.data
              ? <InboxList server={server.id} items={inbox.data} />
              : <SectionNote>Loading…</SectionNote>}
        </div>
      </div>
    </div>
  );
}
