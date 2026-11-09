// The one menu of the console, in the style of claude.ai's account menu: an optional muted header, rows with a 16px
// line icon, a right-aligned shortcut, separators, a ">" row that opens a submenu to the right, a link row that opens
// in a new tab with the external-link mark, and a checkmark on the picked row of a picker. Built on the kit's Menu
// primitives.
//
//   <MenuList label="Account" header="Robert" items={[{ id: "settings", label: "Settings", icon: <Settings />, shortcut: "⌘," }, "separator", ...]} />
//   <DropdownMenu trigger={<Button>Open</Button>} label="Picker" items={...} selected={id} onSelect={setId} />
//
// MenuList is the menu alone, for slots that bring their own popover (ChatList's row menu, the kit's AttachButton).
// DropdownMenu is a trigger plus popover plus MenuList.
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger, Popover, SubmenuTrigger } from "agentic-ui-kit";
import { ArrowUpRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

export interface MenuEntry {
  id: string;
  label: string;
  /** A lucide icon, shown 16px at the left. */
  icon?: ReactNode;
  /** Right-aligned hint such as "⇧⌘,". Only for a key that really works. */
  shortcut?: string;
  /** Right-aligned current value or badge. */
  detail?: ReactNode;
  /** A second, smaller line under the label. */
  description?: string;
  /** Opens this link in a new tab and shows the external-link mark. */
  href?: string;
  danger?: boolean;
  disabled?: boolean;
  onAction?: () => void;
  /** Makes the row a submenu: ">" at the right, the entries open beside it. */
  items?: readonly MenuItemOrSeparator[];
}
export type MenuItemOrSeparator = MenuEntry | "separator";

export interface MenuListProps {
  /** The accessible name. */
  label: string;
  /** A muted line on top, such as the user's name. */
  header?: string;
  items: readonly MenuItemOrSeparator[];
  /** For a picker: the id of the picked row, which gets a checkmark. Pressing a row calls `onSelect`. */
  selected?: string;
  onSelect?: (id: string) => void;
  className?: string;
}

function row(entry: MenuEntry): ReactElement {
  const { id, label, icon, shortcut, detail, description, href, danger, disabled, onAction } = entry;
  return (
    <MenuItem key={id} id={id} className="min-h-8"
      {...(icon && { icon })}
      {...(description && { description })}
      {...(shortcut && { shortcut })}
      {...(danger && { tone: "danger" as const })}
      {...(disabled && { isDisabled: true })}
      {...(href && { href, target: "_blank", rel: "noreferrer" })}
      {...(onAction && { onAction })}
      {...((detail || href) && { detail: href ? <ArrowUpRight className="size-4" aria-hidden="true" /> : detail })}
    >
      {label}
    </MenuItem>
  );
}

function rows(items: readonly MenuItemOrSeparator[]): ReactElement[] {
  return items.map((entry, i) => {
    if (entry === "separator") return <MenuSeparator key={`separator-${i}`} />;
    if (!entry.items) return row(entry);
    return (
      <SubmenuTrigger key={entry.id}>
        {row(entry)}
        <Popover placement="end top" offset={-6} sheet={false}>
          <Menu aria-label={entry.label} className="min-w-48">{rows(entry.items)}</Menu>
        </Popover>
      </SubmenuTrigger>
    );
  });
}

export function MenuList({ label, header, items, selected, onSelect, className }: MenuListProps) {
  const body = rows(items);
  return (
    <Menu aria-label={label} className={className ?? "min-w-56"}
      {...(selected !== undefined && {
        selectionMode: "single" as const, selectedKeys: [selected], disallowEmptySelection: true,
        onSelectionChange: (keys: unknown) => { const key = [...(keys as Set<string>)][0]; if (key !== undefined && onSelect) onSelect(String(key)); },
      })}
    >
      {header ? <MenuSection title={header}>{body}</MenuSection> : body}
    </Menu>
  );
}

export interface DropdownMenuProps extends MenuListProps {
  /** The pressable that opens the menu: a Button or IconButton. */
  trigger: ReactElement;
  placement?: "bottom start" | "bottom end" | "top start" | "top end";
  /** "trigger" makes the popover as wide as the trigger, for pickers. */
  width?: "auto" | "trigger";
  /** Below this viewport width the popover is a bottom sheet; false keeps it floating. */
  sheet?: number | false;
}

export function DropdownMenu({ trigger, placement = "bottom start", width, sheet, ...menu }: DropdownMenuProps) {
  return (
    <MenuTrigger>
      {trigger}
      <Popover placement={placement} {...(width && { width })} {...(sheet !== undefined && { sheet })}>
        <MenuList {...menu} />
      </Popover>
    </MenuTrigger>
  );
}
