// Pages/Project: one project with its details, Instructions, Files, Memory and Chats, and Delete.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, userEvent, within } from "storybook/test";
import { ProjectPage } from "./project-page";

const meta = {
  title: "Pages/Project",
  component: ProjectPage,
  tags: ["autodocs"],
  args: { id: "p1" },
  parameters: { route: "/project/p1", layout: "fullscreen" },
  decorators: [(Story) => <div className="h-dvh"><Story /></div>],
} satisfies Meta<typeof ProjectPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The project's files with the storage they use against the limits, and its chats. */
export const ShowsTheProject: Story = {
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("The files list with the usage line", async () => {
      await expect(await page.findByRole("grid", { name: "Files" })).toBeVisible();
      await expect(page.getByText("chapter-2.md")).toBeVisible();
      await expect(page.getByText("used 1.7 MB of 25 MB, 3 of 20 files")).toBeVisible();
    });
    await step("The chats tab lists the project's chat", async () => {
      await userEvent.click(page.getByRole("tab", { name: "Chats" }));
      await expect(await page.findByText("Why is my Postgres slow")).toBeVisible();
    });
  },
};

/** The bot flags the instructions: the reason shows under the editor and the text stays to be changed. */
export const InstructionsRejected: Story = {
  parameters: {
    msw: {
      handlers: {
        saveProjectInstructions: http.post("/api/projects/:id/instructions", () =>
          HttpResponse.json({ ok: false, reason: "flagged", message: "These instructions were not saved. Change them and try again." }, { status: 422 })),
      },
    },
  },
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Save shows the reason from the bot", async () => {
      const instructions = await page.findByRole("textbox", { name: "Instructions" });
      await userEvent.type(instructions, " More.");
      // Details has a Save too, so look for this section's Save only.
      await userEvent.click(within(instructions.closest("section")!).getByRole("button", { name: "Save" }));
      await expect(await page.findByText("These instructions were not saved. Change them and try again.")).toBeVisible();
    });
  },
};

/** Delete asks first, and the confirm says how many chats go with the project. */
export const DeleteAsksAboutChats: Story = {
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("The confirm names the chats that will be deleted", async () => {
      await userEvent.click(await page.findByRole("button", { name: "Delete project" }));
      const confirmDialog = await page.findByRole("alertdialog");
      await expect(within(confirmDialog).getByText(/This also deletes its 1 chat/)).toBeVisible();
    });
  },
};
