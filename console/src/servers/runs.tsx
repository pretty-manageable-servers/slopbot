// The conversations of a channel, newest first, in a side panel. A conversation is one run and the replies it wrote
// (GET /api/conversations/:channel/runs). Picking one sets ?run=<id> on the page, which shows that conversation.
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, Panel } from "agentic-ui-kit";
import type { ConversationSummary } from "../api-types";
import { get, qs } from "../api";
import { ago } from "../ui/time";

const PAGE = 20;

/** One page of a channel's conversations (the bot's answer to GET .../runs). */
interface ConversationPage { conversations: ConversationSummary[]; hasMore: boolean }

/** The conversations panel. Its size comes from `className`: a column on desktop, a drawer on phones. */
export function RunsPanel({ server, channel, active, onClose, className }: { server: string; channel: string; active: string | undefined; onClose: () => void; className: string }) {
  const navigate = useNavigate();
  const runs = useInfiniteQuery({
    queryKey: ["conversations", server, channel, "runs"],
    queryFn: ({ pageParam }) => get<ConversationPage>(`/api/conversations/${encodeURIComponent(channel)}/runs${qs({ server, limit: PAGE, offset: pageParam })}`),
    initialPageParam: 0,
    // The offset of the next page is the number of conversations so far.
    getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((count, page) => count + page.conversations.length, 0) : undefined),
  });
  const items = runs.data?.pages.flatMap((page) => page.conversations) ?? [];
  const note = runs.isPending ? "Loading…" : runs.isError ? "Conversations are not available right now." : items.length === 0 ? "No conversations yet." : null;
  return (
    <Panel
      title="Conversations"
      actions={<Button variant="ghost" size="sm" onPress={onClose}>Close</Button>}
      variant="flush"
      aria-label="Conversations"
      className={className}
    >
      {note && <p className="px-4 text-chat-muted">{note}</p>}
      <ul className="flex flex-col gap-1 p-2">
        {items.map((item) => (
          <li key={item.id}>
            <Button
              variant="ghost"
              aria-current={item.id === active ? "true" : undefined}
              onPress={() => void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, run: item.id }) })}
              className="flex h-auto! w-full flex-col items-start gap-0.5 py-2 text-left whitespace-normal"
            >
              <span className="line-clamp-2 min-w-0 max-w-full break-words font-medium">{item.title}</span>
              <span className="text-chat-muted text-(length:--chat-ui-font-size-sm)">
                {item.authorName} · {ago(item.end)} · {item.messageCount} {item.messageCount === 1 ? "message" : "messages"}
              </span>
            </Button>
          </li>
        ))}
      </ul>
      {runs.hasNextPage && (
        <div className="p-2">
          <Button variant="outline" size="sm" isDisabled={runs.isFetchingNextPage} onPress={() => void runs.fetchNextPage()}>More</Button>
        </div>
      )}
    </Panel>
  );
}
