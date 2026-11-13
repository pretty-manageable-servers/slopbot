import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, userEvent, within } from "storybook/test";
import { houseoverwatch } from "../mocks/data";
import { failure } from "../mocks/handlers";
import { ReplyBox } from "./reply-box";

/** The box under a channel's transcript: the text goes to the channel through the bot. */
const meta = {
  title: "Components/Servers/ReplyBox",
  component: ReplyBox,
  tags: ["autodocs"],
  args: { server: houseoverwatch.id, channel: "300000000000000001" },
  argTypes: {
    server: { description: "The server of the channel." },
    channel: { description: "The channel or thread the reply is posted in." },
  },
  decorators: [(Story) => <div className="mx-auto w-full max-w-3xl p-4"><Story /></div>],
} satisfies Meta<typeof ReplyBox>;
export default meta;
type Story = StoryObj<typeof meta>;

const path = "/api/conversations/:channel/reply";
const typeAndSend = async (canvasElement: HTMLElement) => {
  await userEvent.type(within(canvasElement).getByRole("textbox"), "Please check the last backup");
  await userEvent.keyboard("{Enter}");
};

/** The user replies and Slopbot picks it up. The box empties. */
export const ReplyToTheChannel: Story = {
  play: async ({ canvasElement, step }) => {
    await step("Type and send", () => typeAndSend(canvasElement));
    await step("The box empties and a notice shows", async () => {
      await expect(await within(canvasElement.ownerDocument.body).findByText("Sent. Slopbot will answer in the channel.")).toBeVisible();
      await expect(within(canvasElement).getByRole("textbox")).toHaveValue("");
    });
  },
};

/** The message reaches Discord but the bot does not pick it up in time. */
export const BotDidNotPickItUp: Story = {
  parameters: { msw: { handlers: { channelReply: http.post(path, () => HttpResponse.json({ id: "r1", messageId: "m1", status: "failed", via: "webhook" })) } } },
  play: async ({ canvasElement }) => {
    await typeAndSend(canvasElement);
    await expect(await within(canvasElement.ownerDocument.body).findByText(/did not pick it up in time/)).toBeVisible();
  },
};

/** The user is over their usage limit; the notice says when it resets. */
export const OverTheUsageLimit: Story = {
  parameters: { msw: { handlers: { channelReply: http.post(path, () => HttpResponse.json({ error: "Limit reached", resetAt: Date.UTC(2026, 10, 9, 3) }, { status: 429 })) } } },
  play: async ({ canvasElement }) => {
    await typeAndSend(canvasElement);
    await expect(await within(canvasElement.ownerDocument.body).findByText(/Limit reached, resets/)).toBeVisible();
  },
};

/** The reply call fails and the text stays in the box. */
export const ReplyFailed: Story = {
  parameters: { msw: { handlers: { channelReply: http.post(path, () => failure(500, "Boom")) } } },
  play: async ({ canvasElement }) => {
    await typeAndSend(canvasElement);
    await expect(await within(canvasElement.ownerDocument.body).findByText("Boom")).toBeVisible();
    await expect(within(canvasElement).getByRole("textbox")).toHaveValue("Please check the last backup");
  },
};
