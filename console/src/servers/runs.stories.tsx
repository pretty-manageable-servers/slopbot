import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, fn, userEvent, within } from "storybook/test";
import { failure, forever } from "../mocks/handlers";
import { houseoverwatch } from "../mocks/data";
import { RunsPanel } from "./runs";

/** The conversations of a channel in a side panel, newest first. Picking one sets `?run=` on the page. */
const meta = {
  title: "Components/Servers/RunsPanel",
  component: RunsPanel,
  tags: ["autodocs"],
  args: { server: houseoverwatch.id, channel: "300000000000000001", active: "r1", onClose: fn(), className: "h-96 w-80 border border-chat-border" },
  argTypes: {
    server: { description: "The server of the channel." },
    channel: { description: "The channel or thread whose conversations are listed." },
    active: { description: "The ID of the conversation that is open on the page; its row is marked current." },
    onClose: { description: "Called by the Close button." },
    className: { description: "The panel's size: a column on desktop, a drawer on phones." },
  },
  decorators: [(Story) => <div className="p-4"><Story /></div>],
} satisfies Meta<typeof RunsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

const path = "/api/conversations/:channel/runs";

/** A channel with a short conversation and one with a very long title. The open one is marked. */
export const Playground: Story = {
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step("The open conversation is current", async () => {
      await expect(await canvas.findByRole("button", { name: /Last backup/ })).toHaveAttribute("aria-current", "true");
    });
    await step("Close calls back", async () => {
      await userEvent.click(canvas.getByRole("button", { name: "Close" }));
      await expect(args.onClose).toHaveBeenCalled();
    });
  },
};

/** Channel with no saved history. */
export const ChannelWithNoSavedHistory: Story = {
  parameters: { msw: { handlers: { channelRuns: http.get(path, () => HttpResponse.json({ conversations: [], hasMore: false })) } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("No conversations yet.")).toBeVisible();
  },
};

/** The conversations call fails. */
export const ConversationsDidNotLoad: Story = {
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("Conversations are not available right now.")).toBeVisible();
  },
  parameters: { msw: { handlers: { channelRuns: http.get(path, () => failure(500, "Boom")) } } },
};

/** The conversations call is slow. */
export const ConversationsAreLoading: Story = {
  parameters: { msw: { handlers: { channelRuns: forever(path) } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("Loading…")).toBeVisible();
  },
};
