import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import { DEGRADED_TEXT, FALLBACK_TEXT, LlmBanner } from "./llm-status";

/** The banner over a page while Slopbot runs on a backup model or its model service is down. Nothing shows when all is well. */
const meta = {
  title: "Components/Chat/LlmBanner",
  component: LlmBanner,
  tags: ["autodocs"],
} satisfies Meta<typeof LlmBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

const mode = (value: "normal" | "fallback" | "offline") => ({ msw: { handlers: { status: http.get("/api/status", () => HttpResponse.json({ mode: value, canChat: value !== "offline" })) } } });

/** All is well, so the banner draws nothing. */
export const EverythingWorks: Story = { parameters: mode("normal") };

/** Bot fell back to the backup model. */
export const BotFellBackToTheBackupModel: Story = {
  parameters: mode("fallback"),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(FALLBACK_TEXT)).toBeVisible();
  },
};

/** The model service is down and chat is paused. */
export const ModelServiceIsDown: Story = {
  parameters: mode("offline"),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(DEGRADED_TEXT)).toBeVisible();
  },
};
