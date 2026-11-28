// Activity: what Bud did, newest first, a page at a time. Items are marked read once they are on screen; the unread dot
// goes with the read mark, and the sidebar count refreshes with it.
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "slop-ui-components";
import { useEffect, useMemo, useRef } from "react";
import { api } from "../api";
import type { ActivityItem } from "../api-types";
import { notifyError } from "../ui/feedback";
import { ago } from "../ui/time";
import { KIND_LABEL } from "./format";
import { activityKey, assistantKey } from "./queries";

const PAGE_SIZE = 20;

export function ActivityFeed() {
  const client = useQueryClient();
  const feed = useInfiniteQuery({
    queryKey: activityKey,
    queryFn: ({ pageParam }) => api.assistantActivity(pageParam, PAGE_SIZE),
    initialPageParam: null as number | null,
    // The feed is newest first, so the last item is the oldest one shown: the next page starts before its time.
    getNextPageParam: (last) => (last.items.length < PAGE_SIZE ? undefined : last.items[last.items.length - 1]!.createdAt),
  });
  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data]);

  // Mark the unread items read once they are shown. An item is sent once, even while the read request is in flight.
  const sent = useRef(new Set<string>());
  useEffect(() => {
    const fresh = items.filter((item) => item.readAt === null && !sent.current.has(item.id)).map((item) => item.id);
    if (fresh.length === 0) return;
    fresh.forEach((id) => sent.current.add(id));
    api.markAssistantActivityRead(fresh)
      .then(() => client.invalidateQueries({ queryKey: assistantKey }))
      .catch((error: unknown) => {
        fresh.forEach((id) => sent.current.delete(id));
        notifyError(error);
      });
  }, [items]);

  return (
    <section aria-labelledby="bud-activity">
      <h2 id="bud-activity" className="m-0 mb-2 flex items-center gap-2 text-ui font-medium">Activity</h2>
      {feed.isError && <p className="m-0 text-ui-sm text-muted">Activity could not be loaded.</p>}
      {!feed.isPending && items.length === 0 && !feed.isError && <p className="m-0 text-ui-sm text-muted">Nothing yet.</p>}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {items.map((item) => <li key={item.id}><ActivityRow item={item} /></li>)}
      </ul>
      {feed.hasNextPage && (
        <Button variant="ghost" size="sm" className="mt-2" isDisabled={feed.isFetchingNextPage} onPress={() => void feed.fetchNextPage()}>Load more</Button>
      )}
    </section>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <div className="flex gap-2">
      <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: item.readAt === null ? "var(--chat-accent)" : "transparent" }}
        role={item.readAt === null ? "img" : undefined} aria-label={item.readAt === null ? "Unread" : undefined} />
      <div className="min-w-0">
        <p className="m-0 text-ui-sm whitespace-pre-wrap break-words">{item.text}</p>
        <p className="m-0 text-ui-sm text-muted">{KIND_LABEL[item.kind]} · {ago(item.createdAt)}</p>
      </div>
    </div>
  );
}
