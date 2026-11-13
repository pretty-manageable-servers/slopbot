// Display preferences for this browser: theme, text size and content width (as in jaa-v2). Kept in localStorage
// and applied on <html> through the kit's theming: data-chat-theme, the root font size (the kit sizes in rem)
// and --chat-content-width.

export type Theme = "system" | "light" | "dark";
export const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" }, { id: "light", label: "Light" }, { id: "dark", label: "Dark" },
];
/** Text sizes as percents of the browser's text size. */
export const TEXT_SIZES = ["90", "100", "110", "125"] as const;
export type TextSize = typeof TEXT_SIZES[number];
/** Content widths. Medium is the kit's default (48rem). */
export const WIDTHS = { narrow: "40rem", medium: "48rem", wide: "60rem" } as const;
export type Width = keyof typeof WIDTHS;

export interface Prefs { theme: Theme; textSize: TextSize; width: Width }
const KEY = "slopbot.display";
const DEFAULTS: Prefs = { theme: "system", textSize: "100", width: "medium" };

export function readPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>; } catch { /* a bad value counts as unset */ }
  return {
    theme: THEMES.some((t) => t.id === saved.theme) ? saved.theme! : DEFAULTS.theme,
    textSize: TEXT_SIZES.includes(saved.textSize as TextSize) ? saved.textSize! : DEFAULTS.textSize,
    width: saved.width && saved.width in WIDTHS ? saved.width : DEFAULTS.width,
  };
}

export function savePrefs(prefs: Prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode: applies until reload */ }
  applyPrefs(prefs);
}

const light = matchMedia("(prefers-color-scheme: light)");

/** Puts the preferences on <html>. Dark is the kit's default, so only light sets data-chat-theme; slop-ui-components always needs data-theme. */
export function applyPrefs(prefs = readPrefs()) {
  const root = document.documentElement;
  const isLight = prefs.theme === "light" || (prefs.theme === "system" && light.matches);
  if (isLight) root.dataset.chatTheme = "light";
  else delete root.dataset.chatTheme;
  root.dataset.theme = isLight ? "light" : "dark";
  root.style.fontSize = prefs.textSize === "100" ? "" : `${prefs.textSize}%`;
  root.style.setProperty("--chat-content-width", WIDTHS[prefs.width]);
}

applyPrefs();
light.addEventListener("change", () => applyPrefs());
