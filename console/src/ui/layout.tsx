// Settings page parts, in claude.ai's style: a group heading with an optional note, then rows with the label and
// help on the left and the control on the right, a divider between rows.
import { defaultIcons } from "agentic-ui-kit";
import type { ReactNode } from "react";

export function SettingsGroup({ title, description, actions, children }: { title?: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8 last:mb-0">
      {(title || actions) && (
        <div className="mb-1 flex items-center justify-between gap-4">
          {title && <h3 className="m-0 text-base font-semibold">{title}</h3>}
          {actions}
        </div>
      )}
      {description && <p className="m-0 mb-2 text-sm text-chat-muted">{description}</p>}
      <div className="flex flex-col divide-y divide-chat-divider">{children}</div>
    </section>
  );
}

/** One setting. With `stack` the control goes under the text (long fields, text areas). */
export function SettingsRow({ label, help, children, stack }: { label: ReactNode; help?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`flex gap-3 py-3 ${stack ? "flex-col" : "flex-col sm:flex-row sm:items-center sm:justify-between sm:gap-6"}`}>
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {help && <div className="text-sm text-chat-muted">{help}</div>}
      </div>
      {children && <div className={stack ? "" : "flex shrink-0 items-center gap-2"}>{children}</div>}
    </div>
  );
}

/** A row that opens something, with a chevron on the right ("How we use your data  >"). */
export function LinkRow({ label, help, onPress, detail }: { label: ReactNode; help?: ReactNode; detail?: ReactNode; onPress: () => void }) {
  return (
    <button type="button" onClick={onPress} className="flex w-full items-center justify-between gap-4 py-3 text-left text-sm text-chat-fg outline-none hover:opacity-80 focus-visible:outline-2 focus-visible:outline-chat-focus">
      <span className="min-w-0">
        <span className="block">{label}</span>
        {help && <span className="block text-chat-muted">{help}</span>}
      </span>
      <span className="flex items-center gap-2 text-chat-muted">{detail}<span className="-rotate-90 [&_svg]:size-4">{defaultIcons.dropdown}</span></span>
    </button>
  );
}

/** A note in place of a section's body: no access, nothing yet, an error. */
export function SectionNote({ children }: { children: ReactNode }) {
  return <p className="m-0 py-6 text-sm text-chat-muted">{children}</p>;
}

/** A server's icon, or its first letter on a tile. */
export function ServerMark({ server, size = 20 }: { server: { name: string; icon?: string | null }; size?: number }) {
  return server.icon
    ? <img src={server.icon} alt="" width={size} height={size} className="shrink-0 rounded-md" referrerPolicy="no-referrer" />
    : <span aria-hidden="true" className="grid shrink-0 place-items-center rounded-md bg-chat-raised text-xs font-semibold" style={{ width: size, height: size }}>{server.name.slice(0, 1).toUpperCase()}</span>;
}
