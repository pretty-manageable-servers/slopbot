import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import { chatShares } from "../mocks/data";
import { failure, forever } from "../mocks/handlers";
import { ShareDialog } from "./share-dialog";

/** The Share dialog of one private chat. Without a link the chat is "Only you"; a link is a frozen copy at /s/<id>. */
const meta = {
  title: "Components/Chat/ShareDialog",
  component: ShareDialog,
  tags: ["autodocs"],
  args: { chatId: "c1", onClose: fn() },
  argTypes: {
    chatId: { description: "The chat to share. The dialog is open while it is set; `null` closes it." },
    triggerRef: { control: false, description: "With a button's ref the dialog floats under it, else it opens as a modal." },
    onClose: { description: "Called when the dialog asks to close." },
  },
} satisfies Meta<typeof ShareDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

const withLink = { msw: { handlers: { chatShares: http.get("/api/chats/:id/shares", () => HttpResponse.json({ shares: chatShares })) } } };

/** A chat nobody has the link to. Copy link goes through the settings so the risks show first. */
export const ChatIsOnlyForYou: Story = {
  play: async ({ step }) => {
    // setup() gives the page a clipboard that Copy link can write to.
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "Share chat" });
    await step("It starts on Only you", async () => {
      await expect(await within(dialog).findByText("Only you")).toBeVisible();
    });
    await step("Copy link shows the notes, then Save makes the link", async () => {
      await user.click(within(dialog).getByRole("button", { name: /Copy link/ }));
      await expect(await within(dialog).findByText("Links travel.")).toBeVisible();
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await expect(await screen.findByText("Link copied")).toBeVisible();
    });
  },
};

/** The link exists and the chat has newer messages than the copy. */
export const LinkIsOnWithNewerMessages: Story = {
  parameters: withLink,
  play: async ({ step }) => {
    const dialog = await screen.findByRole("dialog", { name: "Share chat" });
    await step("It starts on Anyone with the link", async () => {
      await expect(await within(dialog).findByText("Anyone with the link")).toBeVisible();
    });
    await step("Add new messages is offered", async () => {
      const add = within(dialog).getByRole("button", { name: "Add new messages" });
      await waitFor(() => expect(add).toBeEnabled());
      await userEvent.click(add);
      await expect(await screen.findByText("Link updated")).toBeVisible();
    });
  },
};

/** The shares call fails. */
export const SharesDidNotLoad: Story = {
  parameters: { msw: { handlers: { chatShares: http.get("/api/chats/:id/shares", () => failure(500, "Could not read the links")) } } },
  play: async () => {
    await expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the links");
  },
};

/** The shares call is slow. */
export const SharesAreStillLoading: Story = {
  parameters: { msw: { handlers: { chatShares: forever("/api/chats/:id/shares") } } },
  play: async () => {
    await expect(await screen.findByText("Loading…")).toBeVisible();
  },
};
