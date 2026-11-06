// The Servers view's queries: a server's channels and threads (the drawer, the channel page and the palette read
// them) and its Inbox. Keys start with the area: ["conversations", server], ["inbox", server, showDone].
import { queryOptions } from "@tanstack/react-query";
import { get, qs } from "../api";
import type { Conversation, InboxItem } from "../api-types";

/** The server's channels and threads, newest first. */
export const conversationsQuery = (server: string) => queryOptions({
  queryKey: ["conversations", server],
  queryFn: () => get<{ conversations: Conversation[] }>(`/api/conversations${qs({ server })}`).then((r) => r.conversations),
});

/** The server's open Inbox items, or all of them (done too) with showDone. */
export const inboxQuery = (server: string, showDone: boolean) => queryOptions({
  queryKey: ["inbox", server, showDone],
  queryFn: () => get<{ items: InboxItem[] }>(`/api/servers/${encodeURIComponent(server)}/inbox${qs({ done: showDone ? 1 : undefined })}`).then((r) => r.items),
});
