import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppShell, SegmentedControl, SidebarItem, SidebarToggle, defaultIcons } from "agentic-ui-kit";
import { LogOut, Settings } from "lucide-react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Logo } from "../logo";
import { AccountMenu } from "./account-menu";
import { icons } from "./icons";
import { Drawer } from "./sidebar";

/** The drawer frame: toggle at the far left, then the logo and name, then the Chats / Servers switch. */
const meta = {
  title: "Components/Drawer/Sidebar",
  component: Drawer,
  tags: ["autodocs"],
  args: { brand: "Slopbot", logo: <Logo size={28} /> },
  argTypes: { logo: { control: false }, switcher: { control: false }, nav: { control: false }, footer: { control: false }, railActions: { control: false } },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Drawer>;
export default meta;
type Story = StoryObj<typeof meta>;

function Frame({ brand }: { brand: string }) {
  return (
    <AppShell sidebar={
      <Drawer brand={brand} logo={<Logo size={28} />}
        switcher={<SegmentedControl label="View" value="chats" onChange={() => {}}
          options={[{ id: "chats", label: "Chats", icon: icons.chats, iconOnly: true }, { id: "servers", label: "Servers", icon: icons.server, iconOnly: true }]} />}
        nav={<SidebarItem icon={defaultIcons.edit} label="New chat" active />}
        footer={<AccountMenu name="DerpZ" items={[{ id: "settings", label: "Settings", icon: <Settings /> }, "separator", { id: "logout", label: "Log out", icon: <LogOut /> }]} />}>
        <p className="px-2 text-sm text-chat-muted">Chats go here.</p>
      </Drawer>
    }>
      <div className="flex items-center gap-2 p-2 text-chat-muted"><SidebarToggle drawerOnly />Page</div>
    </AppShell>
  );
}

export const Playground: Story = { render: (args) => <Frame brand={args.brand} /> };

export const CollapsesToTheRail: Story = {
  render: (args) => <Frame brand={args.brand} />,
  play: async ({ canvasElement, step }) => {
    await step("Press the toggle at the far left", async () => {
      await userEvent.click(within(canvasElement).getByRole("button", { name: /Collapse sidebar/ }));
    });
    await step("Only the rail is left", async () => {
      await waitFor(() => expect(within(canvasElement).queryByText("Slopbot")).toBeNull());
      await expect(within(canvasElement).getByRole("button", { name: /Expand sidebar/ })).toBeVisible();
    });
  },
};

export const OpensOnAPhone: Story = {
  render: (args) => <Frame brand={args.brand} />,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement, step }) => {
    await step("Press the toggle in the page header", async () => {
      await userEvent.click(within(canvasElement).getByRole("button", { name: /Open sidebar/ }));
    });
    await step("The drawer slides over the page", async () => {
      const name = await within(document.body).findByText("Slopbot");
      await waitFor(() => expect(name).toBeVisible());
    });
  },
};
