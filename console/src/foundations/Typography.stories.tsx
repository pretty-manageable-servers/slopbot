import type { Meta, StoryObj } from "@storybook/react-vite";

/** The brand fonts (src/theme.css) and the kit's type sizes, as the console uses them. */
function Scale() {
  return (
    <div className="flex max-w-3xl flex-col gap-6 p-6 text-chat-fg">
      <Row label="Brand · Source Serif 4, text-lg"><span className="font-chat-serif text-lg">Slopbot</span></Row>
      <Row label="Chat heading · Source Serif 4, text-3xl"><span className="font-chat-serif text-3xl">What should we look at today?</span></Row>
      <Row label="UI · Inter, --chat-ui-font-size"><span className="text-(length:--chat-ui-font-size)">Settings, menus, drawer rows</span></Row>
      <Row label="Small · Inter, --chat-ui-font-size-sm"><span className="text-(length:--chat-ui-font-size-sm) text-chat-muted">Second lines, group titles, hints</span></Row>
      <Row label="Numbers · tabular-nums"><span className="tabular-nums">1,234,567 tokens · $12.40 · 98.6%</span></Row>
      <Row label="IDs · JetBrains Mono"><code className="font-chat-mono text-xs">100000000000000001</code></Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-chat-divider pb-4">
      <span className="text-xs text-chat-muted">{label}</span>
      {children}
    </div>
  );
}

const meta: Meta = { title: "Foundations/Typography", component: Scale, tags: ["!autodocs"] };
export default meta;

export const TypeScale: StoryObj = {};
