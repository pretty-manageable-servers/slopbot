// /memory: what Slopbot remembers about you, across your chats and projects. Search it, filter it by scope, and delete a
// memory. There is no edit: a user changes a memory by telling Slopbot in a chat.
import type { MemoryItem, MemoryList } from "@slopbot/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { ChatHeader, SidebarToggle } from "agentic-ui-kit";
import { Badge, Button, EmptyState, SearchField, Select, confirm } from "slop-ui-components";
import { useState } from "react";
import { api } from "../api";
import { projectsQuery } from "../projects/queries";
import { notifyError } from "../ui/feedback";
import { SectionNote } from "../ui/layout";
import { ago } from "../ui/time";

const memoryKey = ["memory"] as const;
const ALL = "all";

export function MemoryPage() {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState(ALL);
  const projects = useQuery(projectsQuery);
  const projectNames = new Map((projects.data?.projects ?? []).map((project) => [`project:${project.id}`, project.name]));
  const scopes = [
    { id: ALL, label: "All memories" },
    { id: "personal", label: "Personal" },
    ...[...projectNames].map(([id, label]) => ({ id, label })),
  ];
  // Each page is 50 memories. The next page starts after the loaded ones, until all of them are loaded.
  const memories = useInfiniteQuery({
    queryKey: [...memoryKey, { search, scope }],
    queryFn: ({ pageParam }) => api.memoryList({ query: search.trim(), scope: scope === ALL ? undefined : scope, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const filtered = search.trim() !== "" || scope !== ALL;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader leading={<SidebarToggle drawerOnly />} title="Memory" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full flex-col gap-3 px-4 pb-8" style={{ maxWidth: "var(--chat-content-width)" }}>
          <SectionNote>Slopbot remembers these things about you. To change one, ask Slopbot in a chat.</SectionNote>
          <div className="flex flex-col gap-2 sm:flex-row">
            <SearchField aria-label="Search memory" placeholder="Search" value={search} onChange={setSearch} maxLength={200} autoComplete="off" className="flex-1" />
            <Select variant="quiet" aria-label="Scope" options={scopes} value={scope} onChange={setScope} />
          </div>
          <MemoryResults query={memories} projectNames={projectNames} filtered={filtered} />
        </div>
      </div>
    </div>
  );
}

/** The memories of the list. projectNames turns a project scope into the project's name. */
function MemoryResults({ query, projectNames, filtered }: { query: UseInfiniteQueryResult<InfiniteData<MemoryList>>; projectNames: Map<string, string>; filtered: boolean }) {
  if (query.error) return <SectionNote>Memory is not available right now.</SectionNote>;
  if (!query.data) return <SectionNote>Loading…</SectionNote>;
  const items = query.data.pages.flatMap((page) => page.items);
  const total = query.data.pages[0]?.total ?? 0;
  if (items.length === 0) {
    return filtered
      ? <EmptyState headingLevel={2} title="No matches" description="Try another search or scope." />
      : <EmptyState headingLevel={2} title="No memories yet" description="What Slopbot learns about you in your chats is kept here." />;
  }
  return (
    <>
      <p className="m-0 text-ui-sm text-muted">{total} {total === 1 ? "memory" : "memories"}</p>
      <ul aria-label="Memories" className="m-0 flex list-none flex-col divide-y divide-divider rounded-lg border border-border p-0">
        {items.map((item) => <MemoryRow key={item.id} item={item} scope={item.scope === "personal" ? "Personal" : projectNames.get(item.scope) ?? "Project"} />)}
      </ul>
      {items.length < total && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" isDisabled={query.isFetchingNextPage} onPress={() => void query.fetchNextPage()}>Show more</Button>
        </div>
      )}
    </>
  );
}

function MemoryRow({ item, scope }: { item: MemoryItem; scope: string }) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteMemory(item.id),
    onSuccess: () => void client.invalidateQueries({ queryKey: memoryKey }),
    onError: notifyError,
  });
  const askRemove = async () => {
    if (await confirm({ title: "Delete this memory?", description: "Slopbot will forget it. This cannot be undone.", confirmLabel: "Delete", destructive: true })) remove.mutate();
  };

  return (
    <li className="flex flex-col gap-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{item.category}</Badge>
        <span className="text-ui-sm text-muted">{scope} · Updated {ago(item.updated)}</span>
      </div>
      <p className="m-0 whitespace-pre-wrap text-ui">{item.content}</p>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" isDisabled={remove.isPending} onPress={askRemove}>Delete</Button>
      </div>
    </li>
  );
}
