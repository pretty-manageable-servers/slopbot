import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, Button } from "agentic-ui-kit";
import type { ReactNode } from "react";
import { Logo } from "../logo";

/** A few console parts in both themes at once: dark is the default, light is data-chat-theme="light". */
function Side({ light, children }: { light?: boolean; children: ReactNode }) {
  return (
    <div {...(light && { "data-chat-theme": "light" })} className="flex flex-1 flex-col gap-4 bg-chat-bg p-6 text-chat-fg">
      <div className="flex items-center gap-2 font-chat-serif text-lg"><Logo size={26} />Slopbot</div>
      <p className="m-0 text-sm text-chat-muted">{light ? "Light" : "Dark (default)"}</p>
      {children}
    </div>
  );
}

function Sample() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button>Save</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="danger">Revoke all</Button>
      <Badge>Revoked</Badge>
      <Badge tone="outline">Active</Badge>
    </div>
  );
}

function BothThemes() {
  return (
    <div className="flex min-h-screen">
      <Side><Sample /></Side>
      <Side light><Sample /></Side>
    </div>
  );
}

const meta: Meta = { title: "Foundations/Theme", component: BothThemes, tags: ["!autodocs"] };
export default meta;

/** Pinned to dark, so the left side shows the default theme whatever the toolbar says. */
export const SideBySide: StoryObj = { globals: { theme: "dark" } };
