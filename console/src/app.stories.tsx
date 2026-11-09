import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { houseoverwatch } from "./mocks/data";

/** The whole console on the fake bot: the drawer, routing and Settings, at one URL per story. */
const meta: Meta = {
  title: "App/Console",
  render: () => <></>,
  parameters: { app: true },
  tags: ["!autodocs"],
};
export default meta;
type Story = StoryObj;

/** Signed in with a few chats, ready to start a new one. */
export const StartsANewChat: Story = {
  parameters: { route: "/" },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step("The drawer lists the user's chats", async () => {
      await expect(await canvas.findByText("Why is my Postgres slow")).toBeVisible();
    });
  },
};

/** The Servers view of a server the user manages. */
export const BrowsesAServer: Story = { parameters: { route: `/server/${houseoverwatch.id}` } };

/** Settings opened from a link, on the server's share links. */
export const ManagesShareLinks: Story = {
  parameters: { route: "/?settings=shares" },
  play: async ({ canvasElement, step }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await step("Settings opens on Shared links with the server's links", async () => {
      await expect(await dialog.findByRole("heading", { name: "Share links" })).toBeVisible();
      await expect(dialog.getByText("#general")).toBeVisible();
    });
  },
};
