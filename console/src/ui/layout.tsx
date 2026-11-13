// Settings page parts, in claude.ai's style: a group heading with an optional note, then rows with the label and
// help on the left and the control on the right, a divider between rows.
import { Heading } from "slop-ui-components";
import type { ReactNode } from "react";

interface SettingsGroupProps {
  /** The group heading. */
  title?: string;
  /** A muted note under the heading. */
  description?: ReactNode;
  /** Controls on the heading's right, e.g. an "Add" button. */
  actions?: ReactNode;
  /** The rows (SettingsRow or a Table). */
  children: ReactNode;
}

/** A titled group of settings rows with dividers between them. */
export function SettingsGroup({ title, description, actions, children }: SettingsGroupProps) {
  return (
    <section className="mb-8 last:mb-0">
      {(title || actions) && (
        <div className="mb-1 flex items-center justify-between gap-4">
          {title && <Heading as="h3">{title}</Heading>}
          {actions}
        </div>
      )}
      {description && <p className="m-0 mb-2 text-ui-sm text-muted">{description}</p>}
      <div className="flex flex-col divide-y divide-divider">{children}</div>
    </section>
  );
}

/** One setting: label and help on the left, the control on the right (below with `stack`). The library example's Row. */
export function SettingsRow({ label, help, children, stack }: {
  /** What the setting is called. */
  label: ReactNode;
  /** A muted line under the label. */
  help?: ReactNode;
  /** The control, on the right (or below with `stack`). */
  children?: ReactNode;
  /** Put the control under the text instead of beside it. */
  stack?: boolean;
}) {
  return (
    <div className={`flex gap-x-4 gap-y-2 py-3 ${stack ? "flex-col" : "flex-wrap items-center justify-between"}`}>
      <div className="flex min-w-0 flex-col">
        <span className="text-ui leading-5">{label}</span>
        {help && <span className="text-ui-sm leading-4 text-muted">{help}</span>}
      </div>
      {children}
    </div>
  );
}

/** A note in place of a section's body: no access, nothing yet, an error. */
export function SectionNote({ children }: {
  /** The words to show. */
  children: ReactNode;
}) {
  return <p className="m-0 py-6 text-ui text-muted">{children}</p>;
}

/** A server's icon, or its first letter on a tile. */
export function ServerMark({ server, size = 20 }: {
  /** The server to draw. Without an `icon` the tile shows the first letter of the name. */
  server: { name: string; icon?: string | null };
  /** Side of the square in px. */
  size?: number;
}) {
  return server.icon
    ? <img src={server.icon} alt="" width={size} height={size} className="shrink-0 rounded-md" referrerPolicy="no-referrer" />
    : <span aria-hidden="true" className="grid shrink-0 place-items-center rounded-md bg-hover text-xs font-semibold" style={{ width: size, height: size }}>{server.name.slice(0, 1).toUpperCase()}</span>;
}
