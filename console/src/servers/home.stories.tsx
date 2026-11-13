import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { houseoverwatch } from "../mocks/data";
import { failure, forever } from "../mocks/handlers";
import { ServerHome } from "./home";

/** The Inbox page of the picked server, where the Servers view opens. */
const meta = {
  title: "Pages/Server inbox",
  component: ServerHome,
  tags: ["autodocs"],
  parameters: { route: `/server/${houseoverwatch.id}`, layout: "fullscreen" },
  decorators: [(Story) => <div className="h-dvh"><Story /></div>],
} satisfies Meta<typeof ServerHome>;
export default meta;
type Story = StoryObj<typeof meta>;

const path = "/api/servers/:server/inbox";

/** Two open items; the done one stays hidden until Show done. */
export const OpenItemsToGoThrough: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step("Only open items show", async () => {
      await expect(await canvas.findByText("Asked when the server backup runs next.")).toBeVisible();
      await expect(canvas.queryByText("Asked for the house rules again.")).toBeNull();
    });
    await step("Show done adds the done item", async () => {
      await userEvent.click(canvas.getByRole("button", { name: "Show done" }));
      await expect(await canvas.findByText("Asked for the house rules again.")).toBeVisible();
    });
  },
};

/** Inbox is empty, so nothing can be marked done. */
export const InboxIsEmpty: Story = {
  parameters: { msw: { handlers: { inbox: http.get(path, () => HttpResponse.json({ items: [] })) } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Your inbox is empty.")).toBeVisible();
    await waitFor(() => expect(canvas.getByRole("button", { name: "Mark all done" })).toBeDisabled());
  },
};

/** The inbox call fails. */
export const InboxDidNotLoad: Story = {
  parameters: { msw: { handlers: { inbox: http.get(path, () => failure(500, "Boom")) } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("The inbox is not available right now.")).toBeVisible();
  },
};

/** The inbox call is slow. */
export const InboxIsStillLoading: Story = {
  parameters: { msw: { handlers: { inbox: forever(path) } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("Loading…")).toBeVisible();
  },
};
