import type { Meta, StoryObj } from "@storybook/react-vite";
import { Suspense } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { baseRoutes, servers, session } from "../stories/fixtures";
import { ServerPicker } from "./picker";

/** The server picker at the top of the Servers view. With one shared server it is a plain label. */
const meta = {
  title: "Components/Servers/ServerPicker",
  component: ServerPicker,
  tags: ["autodocs"],
  decorators: [(Story) => <div className="w-64 p-2"><Suspense fallback={null}><Story /></Suspense></div>],
} satisfies Meta<typeof ServerPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const OneServer: Story = {
  parameters: { console: { api: { ...baseRoutes, "GET /api/session": { ...session, servers: [servers[0]!] } } } },
};

export const PicksAnotherServer: Story = {
  play: async ({ canvasElement, step }) => {
    await step("Open the picker; the current server is checked", async () => {
      await userEvent.click(await within(canvasElement).findByRole("button", { name: /Server:/ }));
      await expect(await screen.findByRole("menuitemradio", { name: "Houseoverwatch" })).toBeChecked();
    });
    await step("Pick the second server", async () => {
      await userEvent.click(screen.getByRole("menuitemradio", { name: "Second Lab" }));
      await waitFor(() => expect(within(canvasElement).getByRole("button", { name: "Server: Second Lab" })).toBeVisible());
    });
  },
};
