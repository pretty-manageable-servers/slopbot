import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { failure, forever } from "../mocks/handlers";
import { NOW, houseoverwatch, usage } from "../mocks/data";
import { UsageMeter } from "./usage-meter";

/**
 * The ring in the composer: it fills to the larger usage window, and its popover lists each window with its reset
 * time and the banked resets. It loads with the server and again when a reply ends (`busy` goes from true to false).
 */
const meta = {
  title: "Components/Chat/UsageMeter",
  component: UsageMeter,
  tags: ["autodocs"],
  args: { server: houseoverwatch.id, busy: false },
  argTypes: {
    server: { description: "The server whose usage is shown." },
    busy: { description: "A reply is streaming. When it ends the usage is fetched again." },
  },
  decorators: [(Story) => <div className="p-4"><Story /></div>],
} satisfies Meta<typeof UsageMeter>;
export default meta;
type Story = StoryObj<typeof meta>;

const openMeter = (canvasElement: HTMLElement) => userEvent.click(within(canvasElement).getByRole("button", { name: "Usage" }));

/** Plenty of room left on the Pro plan. */
export const PlentyOfRoomLeft: Story = {
  play: async ({ canvasElement, step }) => {
    await step("Open the popover", async () => {
      await openMeter(canvasElement);
      const popover = await screen.findByRole("dialog", { name: "Usage" });
      await expect(await within(popover).findByText("5-hour limit: 42% used")).toBeVisible();
      await expect(within(popover).getByText("Plan: Pro")).toBeVisible();
    });
  },
};

/** The 5-hour window is nearly full and a banked reset can clear it. */
export const NearTheLimitWithAReset: Story = {
  parameters: { msw: { handlers: { usage: http.get("/api/usage", () => HttpResponse.json({
    ...usage,
    windows: [{ kind: "5h", percent: 93, resetAt: NOW + 25 * 60_000, banked: 2 }, { kind: "week", percent: null, resetAt: null, banked: 0 }],
  })) } } },
  play: async ({ canvasElement, step }) => {
    await step("Open the popover; the weekly window has no limit", async () => {
      await openMeter(canvasElement);
      const popover = await screen.findByRole("dialog", { name: "Usage" });
      await expect(await within(popover).findByText("5-hour limit: 93% used")).toBeVisible();
      await expect(within(popover).getByText("Weekly limit: No limit")).toBeVisible();
    });
    await step("Use a reset and confirm", async () => {
      await userEvent.click(screen.getByRole("button", { name: "Use a reset (2)" }));
      await userEvent.click(await screen.findByRole("button", { name: "Use reset" }));
      await waitFor(() => expect(screen.getByText("5-hour limit: 0% used")).toBeVisible());
    });
  },
};

/** The usage call fails. */
export const UsageIsNotAvailable: Story = {
  parameters: { msw: { handlers: { usage: http.get("/api/usage", () => failure(500, "Boom")) } } },
  play: async ({ canvasElement }) => {
    await openMeter(canvasElement);
    await expect(await screen.findByText("Usage is not available right now.")).toBeVisible();
  },
};

/** The usage call is slow. */
export const UsageIsStillLoading: Story = {
  parameters: { msw: { handlers: { usage: forever("/api/usage") } } },
  play: async ({ canvasElement }) => {
    await openMeter(canvasElement);
    await expect(await screen.findByText("Loading…")).toBeVisible();
  },
};
