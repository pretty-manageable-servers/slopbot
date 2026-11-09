// Renders for the show_ui components. The names, descriptions and props are the bot's (showUiSpecs in
// @slopbot/contracts), so the tool, the markup check and the chat use one list. The renders follow the agentic-ui-kit
// playground set (apps/playground/src/lib/ui-components.tsx).
import { Button, ToolViewsProvider, defaultToolViews } from "agentic-ui-kit";
import { VisualsProvider, uiComponentSet, uiMarkupToolView, useUiAction, useUiState, widgetToolView, type UiComponent } from "agentic-ui-kit/visuals";
import { showUiSpecs } from "@slopbot/contracts";
import type { ReactNode } from "react";

const toneClass: Record<string, string> = {
  default: "text-chat-fg",
  accent: "text-chat-accent",
  good: "text-chat-check",
  warning: "text-chat-warning",
  bad: "text-chat-danger",
};

// The text size and face every show_ui render shares.
const body = "font-chat-sans text-(length:--chat-ui-font-size)";
const heading = `${body} font-semibold`;

type Kids = { children?: ReactNode };

/** "New" / "Changed": what the model added stands out in the accent. */
function Tag({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  return (
    <span className={`rounded-chat-sm px-1.5 text-(length:--chat-ui-font-size-sm) font-medium ${quiet ? "border border-chat-border-strong text-chat-muted" : "bg-chat-accent text-chat-accent-fg"}`}>
      {children}
    </span>
  );
}

const renders: Record<string, UiComponent["render"]> = {
  Stack: ({ direction = "column", gap = "md", children }: Kids & { direction?: string; gap?: string }) => (
      <div className={`flex ${direction === "row" ? "flex-row flex-wrap" : "flex-col"} ${{ sm: "gap-1.5", md: "gap-3", lg: "gap-5" }[gap]}`}>{children}</div>
    ),
  Grid: ({ columns = 2, children }: Kids & { columns?: number }) => (
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${Math.floor(36 / columns)}rem), 1fr))` }}>{children}</div>
    ),
  Card: ({ title, subtitle, tag, tone = "default", children }: Kids & { title?: string; subtitle?: string; tag?: string; tone?: string }) => (
      <section className={`rounded-chat-lg border p-3 ${tone === "accent" ? "border-chat-accent" : "border-chat-border"}`}>
        {(title || tag) && (
          <header className="mb-1 flex items-center gap-2">
            {title && <h3 className={heading}>{title}</h3>}
            {tag && <Tag quiet={tone !== "accent"}>{tag}</Tag>}
          </header>
        )}
        {subtitle && <p className="mb-2 text-(length:--chat-ui-font-size-sm) text-chat-muted">{subtitle}</p>}
        {children}
      </section>
    ),
  Heading: ({ text }: { text: string }) => <h2 className={heading}>{text}</h2>,
  Text: ({ text, tone = "default" }: { text: string; tone?: string }) => (
      <p className={`${body} leading-relaxed ${tone === "muted" ? "text-chat-muted" : ""}`}>{text}</p>
    ),
  Metric: ({ label, value, note, tone = "default" }: { label: string; value: string | number; note?: string; tone?: string }) => (
      <div className="min-w-24">
        <div className="text-(length:--chat-ui-font-size-sm) text-chat-muted">{label}</div>
        <div className={`font-chat-sans text-xl font-semibold tabular-nums ${toneClass[tone]}`}>{value}</div>
        {note && <div className="text-(length:--chat-ui-font-size-sm) text-chat-subtle">{note}</div>}
      </div>
    ),
  List: ({ items }: { items: { label: string; detail?: string; tag?: string }[] }) => (
      <ul className="divide-y divide-chat-divider">
        {items.map((item, i) => (
          <li key={i} className={`flex items-baseline gap-2 py-1.5 ${body}`}>
            <span className={item.tag ? "text-chat-accent" : ""}>{item.label}</span>
            {item.tag && <Tag>{item.tag}</Tag>}
            {item.detail && <span className="ml-auto text-chat-muted tabular-nums">{item.detail}</span>}
          </li>
        ))}
      </ul>
    ),
  Checklist: function Checklist({ stateKey, items }: { stateKey: string; items: string[] }) {
      const [state, set] = useUiState();
      const done = (state[stateKey] as string[] | undefined) ?? [];
      return (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item}>
              <label className={`flex items-center gap-2 ${body}`}>
                <input
                  type="checkbox"
                  className="accent-(--chat-accent)"
                  checked={done.includes(item)}
                  onChange={(e) => set(stateKey, e.target.checked ? [...done, item] : done.filter((d) => d !== item))}
                />
                <span className={done.includes(item) ? "text-chat-subtle line-through" : ""}>{item}</span>
              </label>
            </li>
          ))}
        </ul>
      );
    },
  Tabs: function Tabs({ stateKey, value, options }: { stateKey: string; value?: string; options: { id: string; label: string }[] }) {
      const [, set] = useUiState();
      const current = value ?? options[0]!.id;
      return (
        <div role="group" className="inline-flex max-w-full flex-wrap gap-1 self-start rounded-chat-md border border-chat-border p-0.5">
          {options.map((o) => (
            <Button key={o.id} size="sm" variant={o.id === current ? "subtle" : "ghost"} onPress={() => set(stateKey, o.id)} aria-pressed={o.id === current}>
              {o.label}
            </Button>
          ))}
        </div>
      );
    },
  Show: ({ value, equals, fallback, children }: Kids & { value?: string; equals: string; fallback?: boolean }) =>
      value === equals || (value === undefined && fallback) ? <>{children}</> : null,
  Button: function UiButton({ label, variant = "secondary", onPress }: { label: string; variant?: string; onPress: unknown }) {
      const run = useUiAction();
      return (
        <Button size="sm" className="self-start" variant={variant === "primary" ? "primary" : "subtle"} onPress={() => run(onPress)}>
          {label}
        </Button>
      );
    },
};

// Every component the bot offers needs a render. The kit's set also has Table, Badge and Progress, which the bot never offers.
for (const spec of showUiSpecs) {
  if (!renders[spec.name]) throw new Error(`No render for show_ui component ${spec.name}.`);
}
export const uiComponents = uiComponentSet({ renders });

/** show_widget frames load the bot's frame page (WIDGET_FRAME_PATH in src/web-console.ts), outside the page CSP. */
const WIDGET_HOST = { frameUrl: "/console/widget-frame.html" };
const toolViews = { ...defaultToolViews, show_ui: uiMarkupToolView(), show_widget: widgetToolView() };

/** What the chat and the share page need to draw the bot's show_ui and show_widget tool calls. */
export function ChatVisuals({ children }: { children: ReactNode }) {
  return (
    <VisualsProvider components={uiComponents} host={WIDGET_HOST}>
      <ToolViewsProvider tools={toolViews}>{children}</ToolViewsProvider>
    </VisualsProvider>
  );
}
