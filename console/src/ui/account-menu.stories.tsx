import type { Meta, StoryObj } from "@storybook/react-vite";
import { LogOut, Settings } from "lucide-react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { AccountMenu } from "./account-menu";

/**
 * The pill at the bottom of the drawer: a small avatar, the name and a chevron on one line. The menu opens upward
 * and starts with the name as a muted header.
 */
const meta = {
  title: "Components/Drawer/AccountMenu",
  component: AccountMenu,
  tags: ["autodocs"],
  args: {
    name: "DerpZ",
    items: [
      { id: "settings", label: "Settings", icon: <Settings /> },
      "separator",
      { id: "logout", label: "Log out", icon: <LogOut /> },
    ],
  },
  argTypes: { items: { control: "object" } },
  decorators: [(Story) => <div className="fixed bottom-0 left-0 w-64 border-t border-chat-divider p-2"><Story /></div>],
} satisfies Meta<typeof AccountMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const OpensAccountMenu: Story = {
  play: async ({ canvasElement, step }) => {
    await step("Press the pill", async () => {
      await userEvent.click(within(canvasElement).getByRole("button", { name: "Account menu" }));
    });
    await step("The menu shows the name, Settings and Log out", async () => {
      // A menu is named by its trigger button.
      const menu = await screen.findByRole("menu", { name: "Account menu" });
      // The popover fades in; wait for it.
      await waitFor(() => expect(within(menu).getByText("DerpZ")).toBeVisible());
      await expect(within(menu).getByRole("menuitem", { name: "Settings" })).toBeVisible();
      await expect(within(menu).getByRole("menuitem", { name: "Log out" })).toBeVisible();
    });
  },
};
