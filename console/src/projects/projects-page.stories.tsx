// Pages/Projects: the list of projects, and the New project dialog with the bot's limit.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http } from "msw";
import { expect, userEvent, within } from "storybook/test";
import { failure } from "../mocks/handlers";
import { ProjectsPage } from "./projects-page";

const meta = {
  title: "Pages/Projects",
  component: ProjectsPage,
  tags: ["autodocs"],
  parameters: { route: "/projects", layout: "fullscreen" },
  decorators: [(Story) => <div className="h-dvh"><Story /></div>],
} satisfies Meta<typeof ProjectsPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The projects as cards with their file counts, and the count against the limit. */
export const ListsProjects: Story = {
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Each project has a card and the count shows", async () => {
      await expect(await page.findByRole("link", { name: "Thesis" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Garden" })).toBeVisible();
      await expect(page.getByText("2 of 5 projects")).toBeVisible();
    });
  },
};

/** The bot has no project left to give: it answers 409 and the dialog says so. */
export const ProjectLimitReached: Story = {
  parameters: { msw: { handlers: { createProject: http.post("/api/projects", () => failure(409, "project_limit")) } } },
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("A name that the bot refuses shows the limit", async () => {
      await userEvent.click(await page.findByRole("button", { name: "New project" }));
      await userEvent.type(await page.findByRole("textbox", { name: "Name" }), "Another");
      await userEvent.click(page.getByRole("button", { name: "Create project" }));
      await expect(await page.findByText(/You have reached the limit of 5 projects/)).toBeVisible();
    });
  },
};
