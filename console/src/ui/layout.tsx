// Parts shared by the Settings sections and the server list.
import type { ReactNode } from "react";

/** A note in place of a section's body: no access, nothing yet, an error. */
export function SectionNote({ children }: {
  /** The words to show. */
  children: ReactNode;
}) {
  return <p className="m-0 py-6 text-ui text-muted">{children}</p>;
}
