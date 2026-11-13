import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { SectionNote, ServerMark } from "./layout";

/** `SectionNote` stands in for a Settings section's body when there is nothing to show; `ServerMark` is a server's icon or first-letter tile. */
const meta = {
  title: "Components/UI/Settings layout",
  component: SectionNote,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { children: "Manage Server permission is required to see share links." },
} satisfies Meta<typeof SectionNote>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Note: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/Manage Server permission/)).toBeVisible();
  },
};

/** Without an icon the tile shows the first letter of the name. */
export const Mark: Story = {
  render: () => <ServerMark server={{ name: "pretty manageable" }} size={32} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("P")).toBeVisible();
  },
};
