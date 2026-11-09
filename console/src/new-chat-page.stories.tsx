import type { Meta, StoryObj } from "@storybook/react-vite";
import { http } from "msw";
import { expect, userEvent, within } from "storybook/test";
import { ChatPage } from "./chat-page";
import { failure } from "./mocks/handlers";

/** A new chat: the empty state with the composer in the middle. The chat is made on the first attachment or send. */
const meta = {
  title: "Pages/New chat",
  component: ChatPage,
  tags: ["autodocs"],
  parameters: { route: "/", layout: "fullscreen" },
  decorators: [(Story) => <div className="h-dvh"><Story /></div>],
} satisfies Meta<typeof ChatPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const body = (element: HTMLElement) => within(element.ownerDocument.body);

/** The user types a question and sends it; the question shows at once. */
export const StartAChat: Story = {
  play: async ({ canvasElement, step }) => {
    const page = body(canvasElement);
    await step("The greeting and composer show", async () => {
      await expect(await page.findByText("What can Slopbot do for you?")).toBeVisible();
    });
    await step("Send a question", async () => {
      await userEvent.type(page.getByRole("textbox"), "Why is my Postgres slow?");
      await userEvent.keyboard("{Enter}");
      await expect(await page.findByText("Why is my Postgres slow?")).toBeVisible();
    });
  },
};

/** The chat cannot be made, so the question comes back to the composer. */
export const ChatCouldNotBeMade: Story = {
  parameters: { msw: { handlers: { createChat: http.post("/api/chats", () => failure(500, "Private chats are not available")) } } },
  play: async ({ canvasElement }) => {
    const page = body(canvasElement);
    await userEvent.type(await page.findByRole("textbox"), "Hello");
    await userEvent.keyboard("{Enter}");
    await expect(await page.findByText("Private chats are not available")).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("Hello");
  },
};

/** An attachment over the size limit is refused before anything uploads. */
export const FileIsTooBig: Story = {
  play: async ({ canvasElement }) => {
    const page = body(canvasElement);
    await page.findByRole("textbox");
    const input = canvasElement.querySelector<HTMLInputElement>("input[type=file]")!;
    await userEvent.upload(input, new File([new ArrayBuffer(11 * 1024 * 1024)], "backup.zip", { type: "application/zip" }));
    await expect(await page.findByText("backup.zip is larger than 10 MB.")).toBeVisible();
  },
};

