// The drawer's lists for one server: Channels, then Threads, each in the order the server sent (newest first, then
// by name). A channel shows a hash; a channel with its transcripts off is marked so. Empty sections are left out.
import type { ChatListSection } from "agentic-ui-kit";
import type { Conversation } from "../api-types";

export function serverSections(conversations: Conversation[], href: (conversation: Conversation) => string): ChatListSection[] {
  const rows = (kind: Conversation["kind"]) => conversations
    .filter((c) => c.kind === kind)
    .map((c) => {
      const name = c.kind === "thread" ? c.name : `#${c.name}`;
      return { id: c.id, title: c.enabled ? name : `${name} (off)`, href: href(c) };
    });
  return [
    { id: "channels", title: "Channels", items: rows("channel") },
    { id: "threads", title: "Threads", items: rows("thread") },
  ].filter((section) => section.items.length);
}
