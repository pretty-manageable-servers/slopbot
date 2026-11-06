// Settings: a dialog over the chat, sections on the left and the open one on the right (as in jaa-v2 and
// claude.ai). ?settings=<section> opens it; closing drops the param, so the chat underneath stays as it was.
// The kit Modal is the frame; the two columns are inside it. A phone gets the whole screen, with the sections in a row above the body.
import { Button, IconButton, Modal, SegmentedControl } from "agentic-ui-kit";
import { useEffect, useState, type ReactNode } from "react";
import { THEMES, TEXT_SIZES, readPrefs, savePrefs, type Prefs, type TextSize, type Theme, type Width } from "./prefs";

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "more", label: "More settings" },
] as const;
type Section = typeof SECTIONS[number]["id"];

const readSection = (): Section | null => {
  const raw = new URLSearchParams(location.search).get("settings");
  if (raw === null) return null;
  return SECTIONS.find((s) => s.id === raw)?.id ?? "appearance";
};

/** Opens Settings on a section, e.g. from the account menu. */
export function openSettings(section: Section = "appearance") {
  const url = new URL(location.href);
  url.searchParams.set("settings", section);
  history.pushState(history.state, "", url);
  dispatchEvent(new Event("settingschange"));
}

function closeSettings() {
  const url = new URL(location.href);
  url.searchParams.delete("settings");
  history.replaceState(history.state, "", url);
  dispatchEvent(new Event("settingschange"));
}

function useSection() {
  const [section, setSection] = useState(readSection);
  useEffect(() => {
    const update = () => setSection(readSection());
    addEventListener("settingschange", update);
    addEventListener("popstate", update);
    return () => { removeEventListener("settingschange", update); removeEventListener("popstate", update); };
  }, []);
  return section;
}

const CLOSE = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export function SettingsDialog() {
  const section = useSection();
  const label = SECTIONS.find((s) => s.id === section)?.label ?? "";
  return (
    <Modal
      isOpen={section !== null}
      onOpenChange={(open) => { if (!open) closeSettings(); }}
      aria-label="Settings"
      className="overflow-hidden md:h-[min(640px,90vh)] md:w-[min(880px,calc(100vw-2rem))] md:max-w-none! max-md:fixed! max-md:inset-0 max-md:h-dvh max-md:max-h-none! max-md:w-screen max-md:max-w-none! max-md:rounded-none! max-md:border-0!"
    >
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav aria-label="Settings sections" className="flex shrink-0 flex-col gap-1 border-b border-chat-border bg-chat-sidebar p-3 md:w-52 md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-2 pb-2">
          <h2 className="m-0 text-base font-semibold">Settings</h2>
          <IconButton label="Close" className="md:hidden" onPress={closeSettings}>{CLOSE}</IconButton>
        </div>
        <div className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {SECTIONS.map((s) => (
            <Button key={s.id} variant="ghost" className={`shrink-0 justify-start ${s.id === section ? "bg-chat-selected" : ""}`} aria-current={s.id === section ? "page" : undefined}
              onPress={() => { const url = new URL(location.href); url.searchParams.set("settings", s.id); history.replaceState(history.state, "", url); dispatchEvent(new Event("settingschange")); }}>
              {s.label}
            </Button>
          ))}
        </div>
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-chat-border px-5 py-3 max-md:hidden">
          <h3 className="m-0 text-base font-semibold">{label}</h3>
          <IconButton label="Close" onPress={closeSettings}>{CLOSE}</IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {section === "appearance" && <Appearance />}
          {section === "more" && <More />}
        </div>
      </div>
      </div>
    </Modal>
  );
}

function Field({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-sm text-chat-muted">{help}</div>
      </div>
      {children}
    </div>
  );
}

function Appearance() {
  const [prefs, setPrefs] = useState(readPrefs);
  const change = (next: Partial<Prefs>) => { const all = { ...prefs, ...next }; setPrefs(all); savePrefs(all); };
  return (
    <div className="flex flex-col divide-y divide-chat-border">
      <p className="m-0 pb-3 text-sm text-chat-muted">For this browser only.</p>
      <Field label="Theme" help="System follows your device's light or dark mode.">
        <SegmentedControl label="Theme" options={THEMES} value={prefs.theme} onChange={(theme: Theme) => change({ theme })} />
      </Field>
      <Field label="Text size" help="Relative to your browser's text size.">
        <SegmentedControl label="Text size" options={TEXT_SIZES.map((id) => ({ id, label: `${id}%` }))} value={prefs.textSize} onChange={(textSize: TextSize) => change({ textSize })} />
      </Field>
      <Field label="Content width" help="How wide the chat is on a large screen.">
        <SegmentedControl label="Content width" options={[{ id: "narrow", label: "Narrow" }, { id: "medium", label: "Medium" }, { id: "wide", label: "Wide" }]} value={prefs.width} onChange={(width: Width) => change({ width })} />
      </Field>
    </div>
  );
}

function More() {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0">Server, channel, MCP and profile settings are not in the new console yet.</p>
      <p className="m-0"><a className="text-chat-accent" href="/console">Open them in the old console</a></p>
    </div>
  );
}
