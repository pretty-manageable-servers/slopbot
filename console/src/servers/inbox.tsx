// The Inbox rows of one server: who asked, when, the summary as text, a link to the channel it came from, and Done.
// Marking items done writes through POST /api/servers/:id/inbox/done, then refreshes every Inbox query of the server.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "agentic-ui-kit";
import { post } from "../api";
import type { InboxItem } from "../api-types";
import { notifyError } from "../ui/feedback";
import { SectionNote } from "../ui/layout";
import { ago } from "../ui/time";

/** Marks items done: their ids, or "all" for every open item of the server. */
export function useMarkInboxDone(server: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | "all") => post<{ changed: number }>(`/api/servers/${encodeURIComponent(server)}/inbox/done`, { ids }),
    onError: notifyError,
    onSettled: () => client.invalidateQueries({ queryKey: ["inbox", server] }),
  });
}

/** The rows of an Inbox, or a note when there are none. */
export function InboxList({ server, items }: { server: string; items: InboxItem[] }) {
  if (!items.length) return <SectionNote>Your inbox is empty.</SectionNote>;
  return (
    <ol className="m-0 flex list-none flex-col divide-y divide-chat-divider p-0">
      {items.map((item) => <InboxRow key={item.id} server={server} item={item} />)}
    </ol>
  );
}

function InboxRow({ server, item }: { server: string; item: InboxItem }) {
  const markDone = useMarkInboxDone(server);
  const time = new Date(item.created_at).toISOString();
  return (
    <li className={`flex flex-col gap-1.5 py-4 ${item.done_at ? "text-chat-muted" : ""}`}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <strong className="min-w-0 truncate font-semibold">{item.sender}</strong>
        <time dateTime={time} title={new Date(item.created_at).toLocaleString()} className="shrink-0 text-chat-muted">{ago(item.created_at)}</time>
      </div>
      <p className="m-0 text-sm whitespace-pre-wrap">{item.summary}</p>
      <div className="flex items-center gap-3 text-sm">
        <Link to="/server/$serverId/channel/$channelId" params={{ serverId: server, channelId: item.channel }} className="text-chat-accent hover:underline">Open channel</Link>
        {item.done_at
          ? <span className="text-chat-muted">Done</span>
          : <Button variant="outline" size="sm" isDisabled={markDone.isPending} onPress={() => markDone.mutate([item.id])}>Done</Button>}
      </div>
    </li>
  );
}
