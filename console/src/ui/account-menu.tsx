// The account pill at the bottom of the drawer, as in claude.ai: the avatar, the name and a chevron. Pressing it opens
// the account menu upward. On the collapsed rail it is the avatar.
import { Avatar, Button, Menu, MenuHeader, MenuItem, MenuSection, MenuSeparator, MenuTrigger } from "slop-ui-components";
import { useSidebar } from "agentic-ui-kit";
import { ChevronDown, LogOut, Settings } from "lucide-react";

export interface AccountMenuProps {
  /** The display name or Discord username. It is the pill's text and the menu's muted header. */
  name: string;
  avatarUrl?: string;
  onSettings: () => void;
  onLogout: () => void;
}

export function AccountMenu({ name, avatarUrl, onSettings, onLogout }: AccountMenuProps) {
  const { collapsed } = useSidebar();
  return (
    <MenuTrigger>
      <Button variant="ghost" aria-label={collapsed ? name : "Account menu"} className="max-w-full justify-start">
        <Avatar name={name} src={avatarUrl} />
        {!collapsed && <><span className="min-w-0 truncate">{name}</span><ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted" /></>}
      </Button>
      <Menu placement="top start" aria-label="Account" onAction={(key) => (key === "settings" ? onSettings : onLogout)()}>
        <MenuSection aria-label="Account">
          <MenuHeader>{name}</MenuHeader>
          <MenuItem id="settings" icon={<Settings />}>Settings</MenuItem>
        </MenuSection>
        <MenuSeparator />
        <MenuItem id="logout" icon={<LogOut />}>Log out</MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
