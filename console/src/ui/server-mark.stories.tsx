import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ServerMark } from "./layout";

/** A Discord server's icon, or the first letter of its name on a tile when it has none. Always decorative: the name is next to it. */
const meta = {
  title: "Components/UI/Server mark",
  component: ServerMark,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { server: { name: "House Overwatch" } },
  argTypes: {
    server: { control: "object" },
    size: { control: { type: "range", min: 12, max: 64, step: 2 } },
  },
} satisfies Meta<typeof ServerMark>;
export default meta;
type Story = StoryObj<typeof meta>;

const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="gray"/></svg>')}`;

/** Every option of the mark through the controls. */
export const Playground: Story = {};

/** With an icon and without, at the sizes the console uses. */
export const Gallery: Story = {
  render: (args) => (
    <div className="flex items-center gap-4">
      <ServerMark {...args} server={{ name: "House Overwatch", icon }} />
      <ServerMark {...args} />
      <ServerMark {...args} size={32} />
      <ServerMark {...args} server={{ name: "homelab" }} size={32} />
    </div>
  ),
};

/** A server with no icon gets its first letter, upper-cased, so the list stays scannable. */
export const ServerWithoutAnIcon: Story = {
  args: { server: { name: "homelab", icon: null }, size: 32 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("H")).toBeVisible();
  },
};
