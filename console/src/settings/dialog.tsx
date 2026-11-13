// Settings, as in claude.ai: a title bar with a close button over two columns. On the left a search box and the
// sections as vertical tabs; on the right the open section. ?settings=<id> opens
// it from any page, and closing drops the param. A phone gets the whole screen, with the nav as a row on top.
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Component, Suspense, useState, type ReactNode } from "react";
import { Modal, SearchField, Tab, TabList, TabPanel, Tabs, TabSection } from "slop-ui-components";
import { adminMeQuery, useServer } from "../data";
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
  const groups: [SectionGroup, string | undefined][] = [["you", undefined], ["server", server.name], ["admin", "Slopbot team"]];
  const View = current.component;

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) go(undefined); }} title="Settings" size="xl" flush className="md:h-[min(50rem,92dvh)]">
      <Tabs orientation="vertical" selectedKey={current.id} onSelectionChange={(key) => go(String(key))} className="flex-1 md:border-t md:border-divider">
        <div className="flex shrink-0 flex-col md:overflow-y-auto md:border-r md:border-divider">
          <SearchField aria-label="Search settings" placeholder="Search" value={query} onChange={setQuery} className="p-3 pb-0 max-md:hidden" />
          <TabList aria-label="Settings sections">
            {groups.map(([group, title]) => (
              <TabSection key={group} title={title}>
                {shown.filter((s) => s.group === group).map((s) => <Tab key={s.id} id={s.id} icon={s.icon}>{s.label}</Tab>)}
              </TabSection>
            ))}
          </TabList>
          {!shown.length && <p className="m-0 px-5 text-ui-sm text-muted">No settings match.</p>}
        </div>
        <TabPanel id={current.id} className="px-5 py-4 md:px-6">
          <SectionBoundary key={`${current.id}:${server.id}`}>
            <Suspense fallback={<div className="grid place-items-center py-16"><Loader size={40} /></div>}>
              <View />
            </Suspense>
          </SectionBoundary>
        </TabPanel>
      </Tabs>
    </Modal>
  );
}

/** A section that throws (a failed suspense query, a bug) shows its error, not a blank dialog. */
class SectionBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? <SectionNote>{this.state.error.message}</SectionNote> : this.props.children; }
}
