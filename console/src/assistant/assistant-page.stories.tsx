// Pages/Bud: the home chat with what waits for the user, the sprouts and the activity. The states: Bud off, proposals,
// approvals waiting, a paused sprout, and the default feed (its first page with Load more).
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, within } from "storybook/test";
import * as data from "../mocks/data";
import { AssistantPage } from "./assistant-page";

// A GET /api/assistant answer with some of the fixture state replaced.
const state = (over: Partial<ReturnType<typeof data.assistantState>>) =>
  http.get("/api/assistant", () => HttpResponse.json({ ...data.assistantState(), ...over }));

const meta = {
  title: "Pages/Bud",
  component: AssistantPage,
  tags: ["autodocs"],
  parameters: { route: "/assistant", layout: "fullscreen" },
  decorators: [(Story) => <div className="h-dvh"><Story /></div>],
} satisfies Meta<typeof AssistantPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Bud is off: the page says so and offers to turn it on. Nothing else is shown. */
export const Off: Story = {
  parameters: { msw: { handlers: { assistant: state({ settings: { ...data.assistantSettings, enabled: false } }) } } },
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("The off note and the turn-on button show", async () => {
      await expect(await page.findByRole("heading", { name: "Bud is off" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Turn on Bud" })).toBeVisible();
    });
  },
};

/** Proposed sprouts wait for Approve or Decline. */
export const Proposals: Story = {
  parameters: { msw: { handlers: { assistant: state({ tasks: data.assistantTasks.filter((t) => t.status === "proposed"), pending: [] }) } } },
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Each proposal has Approve and Decline", async () => {
      await expect(await page.findByText("Summarise the Postgres release notes every week")).toBeVisible();
      await expect(page.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
      await expect(page.getAllByRole("button", { name: "Decline" })).toHaveLength(2);
    });
  },
};

/** Tool calls Bud asked to make wait under Waiting for you, each with Approve, Deny and Always allow. */
export const ApprovalsWaiting: Story = {
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Both approvals show their summary and their three answers", async () => {
      await expect(await page.findByText("Comment on issue #42: main has been red since 09:10.")).toBeVisible();
      await expect(page.getByText("Send the weekly brief to the team list.")).toBeVisible();
      await expect(page.getAllByRole("button", { name: "Always allow" })).toHaveLength(2);
      await expect(page.getAllByRole("button", { name: "Deny" })).toHaveLength(2);
    });
  },
};

/** A sprout paused after repeated failures shows why, its last error and Resume. */
export const PausedSprout: Story = {
  parameters: { msw: { handlers: { assistant: state({ tasks: data.assistantTasks.filter((t) => t.status === "paused") }) } } },
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("The pause reason, the error and Resume show", async () => {
      await expect(await page.findByText("Track the Tailscale ACL changes")).toBeVisible();
      await expect(page.getByText("Paused after repeated failures")).toBeVisible();
      await expect(page.getByText("The ACL feed returned 503.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    });
  },
};

/** The activity feed shows its first page of 20 and Load more for the rest. */
export const ActivityFirstPage: Story = {
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("The feed has Load more", async () => {
      await expect(await page.findByRole("heading", { name: "Activity" })).toBeVisible();
      await expect(await page.findByRole("button", { name: "Load more" })).toBeVisible();
    });
  },
};
