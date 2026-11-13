// The account pill at the bottom of the drawer, as in claude.ai: the avatar, the name and a chevron. Pressing it opens
// the account menu upward. On the collapsed rail it is the avatar.
import { Menu, MenuHeader, MenuItem, MenuSection, MenuSeparator, MenuTrigger, SidebarUser } from "slop-ui-components";
import { useSidebar } from "agentic-ui-kit";
import { LogOut, Settings } from "lucide-react";

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
      <SidebarUser name={name} collapsed={collapsed} aria-label={collapsed ? name : "Account menu"} {...(avatarUrl && { avatarUrl })} />
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
