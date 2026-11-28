// Settings/Bud: Bud on or off, the daily brief and updates, and the connectors Bud can call.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import BudSettings from "./settings";

const meta = {
  title: "Settings/Bud",
  component: BudSettings,
  tags: ["autodocs"],
  parameters: { route: "/" },
} satisfies Meta<typeof BudSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The connectors list, and adding one by its name and URL. */
export const Connectors: Story = {
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("The saved connector is listed", async () => {
      await expect(await page.findByRole("grid", { name: "Connectors" })).toBeVisible();
      await expect(page.getByText("https://mcp.example.com/github")).toBeVisible();
    });
    await step("A new connector is added to the list", async () => {
      await userEvent.type(page.getByRole("textbox", { name: "Name" }), "linear");
      await userEvent.type(page.getByRole("textbox", { name: "URL" }), "https://mcp.example.com/linear");
      await userEvent.click(page.getByRole("button", { name: "Add connector" }));
      await expect(await page.findByText("https://mcp.example.com/linear")).toBeVisible();
    });
  },
};
