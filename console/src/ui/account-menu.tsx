// The account pill at the bottom of the drawer, as in claude.ai: a small round avatar, the name and a chevron on one
// compact line, not the full width. Pressing it opens the account menu upward. On the collapsed rail it is the avatar.
import { useSidebar } from "agentic-ui-kit";
import { ChevronDown } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { DropdownMenu, type MenuItemOrSeparator } from "./menu";

export interface AccountMenuProps {
  /** The display name or Discord username. It is the pill's text and the menu's muted header. */
  name: string;
  avatarUrl?: string;
  items: readonly MenuItemOrSeparator[];
}

export function AccountMenu({ name, avatarUrl, items }: AccountMenuProps) {
  const { collapsed } = useSidebar();
  const avatar = avatarUrl
    ? <img src={avatarUrl} alt="" className="size-6 shrink-0 rounded-full object-cover" />
    : <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-chat-fg text-xs leading-4 font-medium text-chat-bg">{(name.trim()[0] ?? "?").toUpperCase()}</span>;
  return (
    <DropdownMenu label="Account" header={name} items={items} placement="top start"
      trigger={
        <AriaButton aria-label={collapsed ? name : "Account menu"}
          className={`flex h-9 max-w-full cursor-pointer items-center gap-2 rounded-chat-md text-sm text-chat-fg outline-none data-hovered:bg-chat-hover data-pressed:bg-chat-selected data-focus-visible:ring-2 data-focus-visible:ring-chat-focus ${collapsed ? "justify-center px-1.5" : "px-2"}`}>
          {avatar}
          {!collapsed && <><span className="min-w-0 truncate">{name}</span><ChevronDown className="size-4 shrink-0 text-chat-muted" aria-hidden="true" /></>}
        </AriaButton>
      } />
  );
}
