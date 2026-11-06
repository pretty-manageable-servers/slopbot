// Appearance: display preferences for this browser (prefs.ts), as in claude.ai's General group.
import { SegmentedControl } from "agentic-ui-kit";
import { useState } from "react";
import { THEMES, TEXT_SIZES, readPrefs, savePrefs, type Prefs, type TextSize, type Theme, type Width } from "../../prefs";
import { Select } from "../../ui/controls";
import { SettingsGroup, SettingsRow } from "../../ui/layout";

const THEME_ICONS: Record<Theme, React.ReactNode> = {
  system: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M3 5h18v11H3z" /><path d="M8 20h8" /></svg>,
  light: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  dark: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></svg>,
};
const SIZE_LABELS: Record<TextSize, string> = { "90": "Small", "100": "Default", "110": "Large", "125": "Largest" };

export default function Appearance() {
  const [prefs, setPrefs] = useState(readPrefs);
  const change = (next: Partial<Prefs>) => { const all = { ...prefs, ...next }; setPrefs(all); savePrefs(all); };
  return (
    <SettingsGroup title="General" description="For this browser only.">
      <SettingsRow label="Theme">
        <SegmentedControl label="Theme" options={THEMES.map((t) => ({ id: t.id, label: t.label, icon: THEME_ICONS[t.id], iconOnly: true }))} value={prefs.theme} onChange={(theme: Theme) => change({ theme })} />
      </SettingsRow>
      <SettingsRow label="Text size">
        <Select label="Text size" options={TEXT_SIZES.map((id) => ({ id, label: `${SIZE_LABELS[id]} · ${id}%` }))} value={prefs.textSize} onChange={(textSize: TextSize) => change({ textSize })} />
      </SettingsRow>
      <SettingsRow label="Content width" help="How wide the chat is on a large screen.">
        <Select label="Content width" options={[{ id: "narrow", label: "Narrow" }, { id: "medium", label: "Medium" }, { id: "wide", label: "Wide" }] as const} value={prefs.width} onChange={(width: Width) => change({ width })} />
      </SettingsRow>
    </SettingsGroup>
  );
}
