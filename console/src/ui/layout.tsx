// Parts shared by the Settings sections and the server list.
import type { ReactNode } from "react";

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
