import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { Suspense } from "react";
import { expect, within } from "storybook/test";
import { houseoverwatch } from "../mocks/data";
import { failure, forever } from "../mocks/handlers";
import { ServersPane } from "./pane";

/** The drawer content of the Servers view: the server picker, the Inbox row, then the channels and their threads. */
const meta = {
  title: "Components/Servers/ServersPane",
  component: ServersPane,
  tags: ["autodocs"],
  parameters: { route: `/server/${houseoverwatch.id}` },
  decorators: [(Story) => <div className="w-72 p-2"><Suspense fallback={null}><Story /></Suspense></div>],
} satisfies Meta<typeof ServersPane>;
export default meta;
type Story = StoryObj<typeof meta>;

const path = "/api/conversations";

/** Two open Inbox items, channels and a thread under general. */
export const ChannelsAndThreads: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step("The Inbox row counts the open items", async () => {
      await expect(await canvas.findByText("Inbox (2)")).toBeVisible();
    });
    await step("Channels and the thread are listed, the disabled one marked off", async () => {
      await expect(await canvas.findByText("#general")).toBeVisible();
      await expect(canvas.getByText("Why is the build red")).toBeVisible();
      await expect(canvas.getByText("#memes (off)")).toBeVisible();
    });
  },
};

/** The server has no channels the bot can show yet. */
export const NoChannelsYet: Story = {
  parameters: { msw: { handlers: { conversations: http.get(path, () => HttpResponse.json({ conversations: [] })) } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("Nothing to show yet.")).toBeVisible();
  },
};

/** The channels call fails. */
export const ChannelsDidNotLoad: Story = {
  parameters: { msw: { handlers: { conversations: http.get(path, () => failure(500, "Boom")) } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("The channels are not available right now.")).toBeVisible();
  },
};

/** The channels call is slow; the Inbox row is already there. */
export const ChannelsAreLoading: Story = {
  parameters: { msw: { handlers: { conversations: forever(path) } } },
};
