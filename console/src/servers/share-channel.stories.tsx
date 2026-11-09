import type { Meta, StoryObj } from "@storybook/react-vite";
import { http } from "msw";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import { houseoverwatch } from "../mocks/data";
import { failure } from "../mocks/handlers";
import { ShareChannelDialog } from "./share-channel";

/** The dialog that makes a share link of a channel: a frozen copy of its newest messages, at /s/<id>. */
const meta = {
  title: "Components/Servers/ShareChannelDialog",
  component: ShareChannelDialog,
  tags: ["autodocs"],
  args: { server: houseoverwatch.id, channel: "300000000000000001", open: true, onClose: fn() },
  argTypes: {
    server: { description: "The server of the channel." },
    channel: { description: "The channel or thread to share." },
    open: { description: "Whether the dialog is open." },
    onClose: { description: "Called when the dialog closes, by Close or after the link is made." },
  },
} satisfies Meta<typeof ShareChannelDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The user turns off reasoning and makes the link. */
export const ShareTheChannel: Story = {
  play: async ({ args, step }) => {
    const dialog = await screen.findByRole("dialog", { name: "Share this conversation" });
    await step("Reasoning and tool activity are included by default", async () => {
      await expect(within(dialog).getByRole("checkbox", { name: /Include Slopbot reasoning/ })).toBeChecked();
      await userEvent.click(within(dialog).getByRole("checkbox"));
    });
    await step("Create link closes the dialog", async () => {
      await userEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
      await waitFor(() => expect(args.onClose).toHaveBeenCalled());
    });
  },
};

/** The share call fails and the dialog stays open. */
export const ShareFailed: Story = {
  parameters: { msw: { handlers: { createShare: http.post("/api/shares", () => failure(500, "Could not share")) } } },
  play: async ({ args }) => {
    const dialog = await screen.findByRole("dialog", { name: "Share this conversation" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await expect(await screen.findByText("Could not share")).toBeVisible();
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};
