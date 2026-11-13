import type { Meta, StoryObj } from "@storybook/react-vite";

/** The `--chat-*` theme variables from src/theme.css, the one place console colors are defined. */
const GROUPS: { title: string; tokens: string[] }[] = [
  { title: "Surfaces", tokens: ["bg", "sidebar", "surface", "raised", "popover", "bubble", "code-bg", "inline-code"] },
  { title: "States", tokens: ["hover", "selected", "popover-hover", "focus"] },
  { title: "Lines", tokens: ["border", "border-strong", "divider", "popover-border", "code-border"] },
  { title: "Text", tokens: ["fg", "muted", "subtle", "accent", "accent-fg"] },
  { title: "Signals", tokens: ["check", "warning", "warning-bg", "danger"] },
];

function Swatch({ token }: { token: string }) {
  const name = `--chat-${token}`;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="size-8 shrink-0 rounded-chat-sm border border-chat-border" style={{ background: `var(${name})` }} />
      <code className="font-chat-mono text-xs text-chat-fg">{name}</code>
      <code className="ml-auto font-chat-mono text-xs text-chat-muted tabular-nums">{value || "kit default"}</code>
    </div>
  );
}

function Palette() {
  return (
    <div className="grid max-w-4xl grid-cols-1 gap-x-10 gap-y-6 p-6 md:grid-cols-2">
      {GROUPS.map((group) => (
        <section key={group.title}>
          <h2 className="mb-2 text-sm font-medium text-chat-fg">{group.title}</h2>
          <div className="divide-y divide-chat-divider">{group.tokens.map((t) => <Swatch key={t} token={t} />)}</div>
        </section>
      ))}
    </div>
  );
}

const meta: Meta = { title: "Foundations/Colors", component: Palette, tags: ["!autodocs"] };
export default meta;

/** Every theme color. Switch the toolbar theme to see the light values. */
export const Palette_: StoryObj = { name: "Palette" };
