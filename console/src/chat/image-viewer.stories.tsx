import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent, waitFor } from "storybook/test";
import { ImageViewer } from "./image-viewer";

/** The full image of a message attachment, in a modal. The chat opens it when the user clicks an attachment picture. */
const meta = {
  title: "Components/Chat/ImageViewer",
  component: ImageViewer,
  tags: ["autodocs"],
  args: { image: { src: "/api/chats/c1/images/img1", alt: "query-plan.png" }, onClose: fn() },
  argTypes: {
    image: { control: "object", description: "The picture to show. `null` keeps the modal closed." },
    onClose: { description: "Called when the user presses Escape or clicks outside the picture." },
  },
} satisfies Meta<typeof ImageViewer>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A picture is open; Escape closes it. */
export const Playground: Story = {
  play: async ({ args, step }) => {
    await step("The picture shows with its name", async () => {
      await expect(await screen.findByRole("img", { name: "query-plan.png" })).toBeVisible();
    });
    await step("Escape asks to close", async () => {
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(args.onClose).toHaveBeenCalled());
    });
  },
};
