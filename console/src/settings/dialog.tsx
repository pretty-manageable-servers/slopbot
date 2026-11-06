// Settings, as in claude.ai: a title bar with a close button over two columns. On the left a search box and the
// sections in groups (You, the picked server, Slopbot team); on the right the open section. ?settings=<id> opens
// it from any page, and closing drops the param. A phone gets the whole screen, with the nav as a row on top.
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { IconButton, Modal } from "agentic-ui-kit";
import { Component, Suspense, useState, type ReactNode } from "react";
import { adminMeQuery, useServer } from "../data";
import { icons } from "../ui/icons";
import { SectionNote } from "../ui/layout";
import { Loader } from "../logo";
import { DEFAULT_SECTION, SECTIONS, sectionById, type SectionGroup } from "./sections";

/** Opens Settings on a section. For links, use search={{ settings: id }}. */
export function useOpenSettings() {
  const navigate = useNavigate();
  return (section: string = DEFAULT_SECTION) => void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, settings: section }) });
}

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

export function SettingsDialog() {
  const { settings } = useSearch({ strict: false }) as { settings?: string };
  const navigate = useNavigate();
  const server = useServer();
  const { data: team } = useQuery(adminMeQuery);
  const [query, setQuery] = useState("");
  const open = settings !== undefined;
  const go = (id: string | undefined) => void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, settings: id }), replace: true });

  const visible = SECTIONS.filter((s) => s.group !== "admin" || team);
  const words = fold(query).split(/\s+/).filter(Boolean);
  const shown = words.length ? visible.filter((s) => words.every((w) => fold([s.label, ...s.keywords].join(" ")).includes(w))) : visible;
  const current = sectionById(settings) && visible.some((s) => s.id === settings) ? sectionById(settings)! : sectionById(DEFAULT_SECTION)!;
  const groupTitle: Record<SectionGroup, string | null> = { you: null, server: server.name, admin: "Slopbot team" };
  const View = current.component;

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => { if (!next) go(undefined); }}
      aria-label="Settings"
      className="overflow-hidden md:h-[min(800px,92vh)] md:w-[min(1040px,calc(100vw-2rem))] md:max-w-none! max-md:fixed! max-md:inset-0 max-md:h-dvh max-md:max-h-none! max-md:w-screen max-md:max-w-none! max-md:rounded-none! max-md:border-0!"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-chat-border py-2 pr-2 pl-4">
          <h2 className="m-0 text-base font-medium">Settings</h2>
          <IconButton label="Close" onPress={() => go(undefined)}>{icons.close}</IconButton>
        </header>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav aria-label="Settings sections" className="flex shrink-0 flex-col gap-2 border-b border-chat-border p-3 md:w-56 md:overflow-y-auto md:border-r md:border-b-0">
            <label className="flex items-center gap-2 rounded-chat-sm border border-chat-border bg-chat-surface px-2.5 py-1.5 text-chat-muted max-md:hidden">
              {icons.search}
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search settings"
                className="min-w-0 flex-1 bg-transparent text-sm text-chat-fg outline-none placeholder:text-chat-muted" />
            </label>
            <div className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
              {(["you", "server", "admin"] as const).map((group, index) => {
                const items = shown.filter((s) => s.group === group);
                if (!items.length) return null;
                return (
                  <div key={group} className="contents md:flex md:flex-col md:gap-0.5">
                    {index > 0 && <hr className="mx-2 my-2 border-chat-divider max-md:hidden" />}
                    {groupTitle[group] && <div className="truncate px-2 pb-1 text-xs text-chat-muted max-md:hidden">{groupTitle[group]}</div>}
                    {items.map((s) => (
                      <button key={s.id} type="button" onClick={() => go(s.id)} aria-current={s.id === current.id ? "page" : undefined}
                        className={`flex shrink-0 items-center gap-2.5 rounded-chat-sm px-2 py-1.5 text-left text-sm text-chat-fg outline-none hover:bg-chat-hover focus-visible:outline-2 focus-visible:outline-chat-focus ${s.id === current.id ? "bg-chat-selected" : ""}`}>
                        <span className="text-chat-muted">{s.icon}</span>{s.label}
                      </button>
                    ))}
                  </div>
                );
              })}
              {!shown.length && <p className="m-0 px-2 text-sm text-chat-muted">No settings match.</p>}
            </div>
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4 md:px-6">
            <SectionBoundary key={`${current.id}:${server.id}`}>
              <Suspense fallback={<div className="grid place-items-center py-16"><Loader size={40} /></div>}>
                <View />
              </Suspense>
            </SectionBoundary>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** A section that throws (a failed suspense query, a bug) shows its error, not a blank dialog. */
class SectionBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? <SectionNote>{this.state.error.message}</SectionNote> : this.props.children; }
}
