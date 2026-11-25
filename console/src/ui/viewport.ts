// Keeps the app frame (top bar, messages, composer) inside the part of the screen the user can see.
// iOS Safari does not shrink the page when the on-screen keyboard opens: it pans the whole page up under the
// keyboard, so the top bar leaves the screen. Android does the same unless the viewport tag says
// interactive-widget=resizes-content (see index.html). This writes the visible height and offset to
// --app-height and --app-top, and theme.css pins `.app-frame` to them, so only the message list scrolls.

/** The CSS variables for a visual viewport, or null when the user has zoomed in: then the page keeps its full size. */
export function frameVars(vv: { height: number; offsetTop: number; scale: number }): Record<string, string> | null {
  if (Math.abs(vv.scale - 1) > 0.01) return null;
  return { "--app-height": `${Math.round(vv.height)}px`, "--app-top": `${Math.round(Math.max(0, vv.offsetTop))}px` };
}

export function pinToVisualViewport(root: HTMLElement = document.documentElement): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const vars = frameVars(vv);
    for (const name of ["--app-height", "--app-top"]) {
      if (vars) root.style.setProperty(name, vars[name]!);
      else root.style.removeProperty(name);
    }
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}
