// The drawer frame. The kit's Sidebar puts the toggle at the right and sizes the logo to 20px; claude.ai has the toggle
// at the far left, then the brand, then the mode switch, in one row. Same behavior as the kit's frame: a pinned sidebar collapses
// to an icon rail, on phones it is a drawer, and Cmd+B toggles it (AppShell's shortcut).
// The toggle never moves: open, collapsed to the rail, or closed with the page header's toggle (the kit's ChatHeader,
// h-12 and px-3), it sits in the same 12px-from-the-left spot of a 48px row, so the pointer or thumb stays put.
import { SidebarList, SidebarToggle, useSidebar } from "agentic-ui-kit";
import { SidebarSimple } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/** Theme icons for the kit, so every drawer toggle (the kit's page headers too) is the same icon: a window with its
 *  left panel filled, as claude.ai's. Phosphor's SidebarSimple in the fill weight; lucide has only the outline. */
export const themeIcons = { sidebar: <SidebarSimple weight="fill" className="size-4" aria-hidden="true" /> };

export interface DrawerProps {
  /** The app name, big and serif. */
  brand: string;
  /** The logo, sized by the caller. Stays at the top of the collapsed rail. */
  logo: ReactNode;
  /** Right of the brand: the Chats / Servers switch. Hidden on the rail. */
  switcher?: ReactNode;
  /** Icon-only buttons on the collapsed rail. */
  railActions?: ReactNode;
  /** Fixed rows under the header. */
  nav?: ReactNode;
  /** The scrolling middle. Hidden on the rail. */
  children?: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ brand, logo, switcher, railActions, nav, children, footer }: DrawerProps) {
  const { collapsed } = useSidebar();
  return (
    <div className={`flex h-full flex-col font-chat-sans ${collapsed ? "w-13" : "w-full"}`}>
      <div className="flex h-12 shrink-0 items-center gap-1 px-3">
        <SidebarToggle />
        {!collapsed && (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 font-chat-serif text-xl text-fg">
            {logo}
            <span className="min-w-0 truncate">{brand}</span>
          </div>
        )}
        {!collapsed && switcher}
      </div>
      {collapsed && <div className="flex h-10 shrink-0 items-center justify-center">{logo}</div>}
      {collapsed && railActions && <div className="flex shrink-0 flex-col items-center gap-1 pb-2">{railActions}</div>}
      {nav && <SidebarList className={`shrink-0 px-2 pb-2 ${collapsed ? "items-center" : ""}`}>{nav}</SidebarList>}
      {!collapsed && <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4 [scrollbar-width:thin]">{children}</div>}
      {collapsed && <div className="flex-1" />}
      {footer && <div className="shrink-0 border-t border-divider p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">{footer}</div>}
    </div>
  );
}
