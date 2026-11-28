// Pages/Bud sprout: one sprout with its chat, its tool rules, its wake and its effort. A rule can be added by its tool name.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { http, HttpResponse } from "msw";
import * as data from "../mocks/data";
import { SproutPage } from "./sprout-page";

const meta = {
  title: "Pages/Bud sprout",
  component: SproutPage,
  tags: ["autodocs"],
  args: { id: "t-active" },
  parameters: { route: "/assistant/task/t-active", layout: "fullscreen" },
  decorators: [(Story) => <div className="h-dvh"><Story /></div>],
} satisfies Meta<typeof SproutPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The sprout's goal, its rules per tool, its interval wake and its effort. Adding a rule shows it in the table. */
export const SproutPageStory: Story = {
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("The goal and its rules show", async () => {
      await expect(await page.findByRole("heading", { name: "Watch the build dashboard for failures" })).toBeVisible();
      await expect(page.getByRole("grid", { name: "Tool rules" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Effect for github_comment/ })).toBeVisible();
    });
    await step("A new tool gets a rule that asks first", async () => {
      await userEvent.type(page.getByRole("textbox", { name: "Tool name" }), "send_email");
      await userEvent.click(page.getByRole("button", { name: "Add rule" }));
      await expect(await page.findByText("send_email")).toBeVisible();
    });
    await step("The wake and the effort can be edited and saved", async () => {
      await expect(page.getByRole("textbox", { name: "Every, minutes" })).toHaveValue("60");
      await expect(page.getByRole("button", { name: "Save sprout" })).toBeEnabled();
    });
  },
};

/** The sprout's actions sit beside its goal, the same as in the list: an active sprout can be paused or cancelled. */
export const SproutActionsShown: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  },
};

/** Bud's wake prompts are small notes, not the user's bubbles. Show details opens the prompt text. */
export const WakeNotes: Story = {
  parameters: { msw: { handlers: { chatMessages: http.get("/api/chats/:id/messages", () => HttpResponse.json({ messages: data.chatWithWakes, hasMore: false, streamId: 1 })) } } },
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Each wake shows its trigger and no prompt text", async () => {
      await expect(await page.findByText("Bud woke up · daily brief")).toBeVisible();
      await expect(page.getByText("Bud woke up · approval result")).toBeVisible();
      await expect(page.queryByText(/untrusted-data/)).toBeNull();
    });
    await step("Show details reveals the prompt", async () => {
      await userEvent.click(page.getAllByRole("button", { name: "Show details" })[1]!);
      await expect(await page.findByText(/untrusted-data/)).toBeVisible();
    });
  },
};
