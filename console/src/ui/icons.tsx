// Line icons for the settings nav and the drawer toggle, 16px on a 24 grid with a 1.75 stroke like the kit's.
import type { ReactNode } from "react";

const icon = (...paths: string[]): ReactNode => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d) => <path key={d} d={d} />)}
  </svg>
);

export const icons = {
  account: icon("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 20a8 8 0 0 1 16 0"),
  appearance: icon("M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-1.5 3.3A1.6 1.6 0 0 1 12 21Z", "M7.5 10.5h.01", "M10.5 7h.01", "M15 7.5h.01"),
  usage: icon("M12 21a9 9 0 1 0-9-9", "M12 7v5l3 2"),
  server: icon("M4 5h16v6H4z", "M4 13h16v6H4z", "M8 8h.01", "M8 16h.01"),
  channels: icon("M5 9h14", "M5 15h14", "M10 4 8 20", "M16 4l-2 16"),
  mcp: icon("M9 7V3", "M15 7V3", "M6 7h12v4a6 6 0 0 1-12 0Z", "M12 17v4"),
  shares: icon("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"),
  bot: icon("M5 9h14v10H5z", "M12 5v4", "M9 14h.01", "M15 14h.01", "M12 5h.01"),
  limits: icon("M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"),
  users: icon("M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M2 21a7 7 0 0 1 14 0", "M16 3.5a4 4 0 0 1 0 7", "M22 21a7 7 0 0 0-4-6.3"),
  servers: icon("M3 7l9-4 9 4-9 4Z", "M3 12l9 4 9-4", "M3 17l9 4 9-4"),
  search: icon("M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z", "m20 20-4-4"),
  close: icon("M18 6 6 18", "M6 6l12 12"),
  chats: icon("M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z"),
  inbox: icon("M3 13h5l1 3h6l1-3h5", "M5 5h14l2 8v6H3v-6Z"),
  thread: icon("M6 4v8a4 4 0 0 0 4 4h8", "m15 13 3 3-3 3"),
} satisfies Record<string, ReactNode>;
