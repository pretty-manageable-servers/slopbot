import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "agentic-ui-kit";
import { Cog, CircleHelp, Globe, Info, KeyRound, LogOut, Settings, Trash2 } from "lucide-react";
import { useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { DropdownMenu, type MenuItemOrSeparator } from "./menu";

/**
 * The console's one menu, in the style of claude.ai's account menu. `DropdownMenu` is a trigger plus popover; the
 * menu alone is `MenuList`. Rows are data: an icon, a shortcut, a link that opens in a new tab, a danger tone, a
 * `items` list for a submenu, and `"separator"` between groups.
 */
const meta = {
  title: "Components/Menu/Menu",
  component: DropdownMenu,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { label: "Account", trigger: <Button variant="subtle">Open menu</Button>, items: [] },
  argTypes: {
    header: { control: "text", description: "A muted line on top, such as the user's name." },
    placement: { control: "inline-radio", options: ["bottom start", "bottom end", "top start", "top end"] },
    width: { control: "inline-radio", options: ["auto", "trigger"] },
    trigger: { control: false },
    items: { control: "object" },
    selected: { control: "text", description: "Makes the menu a picker: this row id has the checkmark." },
  },
} satisfies Meta<typeof DropdownMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

const account: MenuItemOrSeparator[] = [
  { id: "settings", label: "Settings", icon: <Settings />, shortcut: "⇧⌘," },
  { id: "language", label: "Language", icon: <Globe /> },
  { id: "help", label: "Get help", icon: <CircleHelp /> },
  "separator",
  { id: "learn", label: "Learn more", icon: <Info />, items: [
    { id: "about", label: "About Slopbot", href: "https://example.com/about" },
    { id: "terms", label: "Terms of service", href: "https://example.com/terms" },
  ] },
  "separator",
  { id: "keys", label: "Get API keys", icon: <KeyRound />, href: "https://example.com/keys" },
  { id: "logout", label: "Log out", icon: <LogOut /> },
];

/** Every option of the menu through the controls. */
export const Playground: Story = { args: { header: "DerpZ", items: account } };

/** The row kinds side by side: plain, header with shortcut and link, danger, and a picker. */
export const Gallery: Story = {
  render: (args) => {
    const [picked, setPicked] = useState("medium");
    return (
      <div className="flex gap-4">
        <DropdownMenu {...args} label="Plain" trigger={<Button variant="subtle">Plain</Button>}
          items={[{ id: "a", label: "Rename", icon: <Cog /> }, { id: "b", label: "Share" }]} />
        <DropdownMenu {...args} label="Account" header="DerpZ" trigger={<Button variant="subtle">Header, shortcut, link</Button>} items={account} />
        <DropdownMenu {...args} label="Danger" trigger={<Button variant="subtle">Danger</Button>}
          items={[{ id: "a", label: "Rename", icon: <Cog /> }, "separator", { id: "d", label: "Delete", icon: <Trash2 />, danger: true }]} />
        <DropdownMenu {...args} label="Effort" selected={picked} onSelect={setPicked} trigger={<Button variant="subtle">Picker: {picked}</Button>}
          items={[{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }]} />
      </div>
    );
  },
};

export const BrowsesTheLearnMoreSubmenu: Story = {
  args: { header: "DerpZ", items: account },
  play: async ({ canvasElement, step }) => {
    await step("Open the menu", async () => {
      await userEvent.click(within(canvasElement).getByRole("button", { name: "Open menu" }));
      await expect(await screen.findByRole("menu", { name: "Account" })).toBeVisible();
    });
    await step("Open the submenu beside its row", async () => {
      await userEvent.click(screen.getByRole("menuitem", { name: "Learn more" }));
      await waitFor(() => expect(screen.getByRole("menu", { name: "Learn more" })).toBeVisible());
      await expect(screen.getByRole("menuitem", { name: "About Slopbot" })).toHaveAttribute("target", "_blank");
    });
  },
};

export const PicksAnotherOption: Story = {
  args: { label: "Effort", selected: "medium", width: "trigger", items: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }] },
  render: (args) => {
    const [picked, setPicked] = useState(args.selected ?? "");
    return <DropdownMenu {...args} selected={picked} onSelect={setPicked} trigger={<Button variant="subtle" className="w-40 justify-start">Effort: {picked}</Button>} />;
  },
  play: async ({ canvasElement, step }) => {
    await step("Open the picker; the current row is checked", async () => {
      await userEvent.click(within(canvasElement).getByRole("button"));
      await expect(await screen.findByRole("menuitemradio", { name: "Medium" })).toBeChecked();
    });
    await step("Pick High", async () => {
      await userEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
      await waitFor(() => expect(within(canvasElement).getByRole("button")).toHaveTextContent("Effort: high"));
    });
  },
};
