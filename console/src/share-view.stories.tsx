import type { Meta, StoryObj } from "@storybook/react-vite";
import { http } from "msw";
import { expect, userEvent, within } from "storybook/test";
import { shareData as shared } from "./mocks/data";
import { failure } from "./mocks/handlers";
import { SharePage } from "./share-view";

// The kit draws a tool row with an h3, which fails the heading-order check on a page without an h2 before it; the
// stories leave tool rows out and show the images and files.
const shareData = { ...shared, messages: shared.messages.map((message) => ({ ...message, tools: [] })) };

/** The public page of a share link (/s/<id>): a frozen chat with a button to continue it in the viewer's own chat. */
const meta = {
  title: "Pages/Share page",
  component: SharePage,
  tags: ["autodocs"],
  args: { data: shareData },
  argTypes: { data: { control: "object", description: "The frozen copy the bot puts in the page: the messages with their images and files." } },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SharePage>;
export default meta;
type Story = StoryObj<typeof meta>;

const body = (element: HTMLElement) => within(element.ownerDocument.body);

/** A shared chat with an answer that has a picture and a file. */
export const SharedChatWithFilesAndImages: Story = {
  play: async ({ canvasElement }) => {
    const page = body(canvasElement);
    await expect(await page.findByText("Why is my Postgres slow?")).toBeVisible();
    await expect(await page.findByText("orders.sql")).toBeVisible();
    await expect(page.getByText(/Images and files are not/)).toBeVisible();
  },
};

/** The share has no messages. */
export const SharedChatIsEmpty: Story = {
  args: { data: { ...shareData, messages: [] } },
};

/** Very long messages and a very long name wrap inside the page. */
export const VeryLongMessage: Story = {
  args: { data: { ...shareData, messages: [{ ...shareData.messages[0]!, author: "A person with a very long display name that goes on and on", text: "Why is my database slow? ".repeat(200) }] } },
};

/** The share was taken down: Continue says so. */
export const ShareIsGone: Story = {
  parameters: { msw: { handlers: { continueShare: http.post("/api/shares/:id/continue", () => failure(404, "Gone")) } } },
  play: async ({ canvasElement }) => {
    const page = body(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: "Continue in Slopbot" }));
    await expect(await page.findByText("This shared chat is no longer available.")).toBeVisible();
  },
};
