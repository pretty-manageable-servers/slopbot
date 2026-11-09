import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import * as data from "../mocks/data";
import { engineStream, failure, forever } from "../mocks/handlers";

/** One channel's transcript, read-only, with live updates, a conversations panel and a reply box when the user can send. */
const meta: Meta = {
  title: "Pages/Channel transcript",
  render: () => <></>,
  parameters: { app: true, route: `/server/${data.houseoverwatch.id}/channel/300000000000000001` },
  tags: ["!autodocs"],
};
export default meta;
type Story = StoryObj;

const GENERAL = "300000000000000001";
const messages = "/api/conversations/:channel/messages";
const body = (element: HTMLElement) => within(element.ownerDocument.body);

/** Sam, DerpZ and Slopbot talk about the backup; a message nobody used is folded. */
export const BackupTalkInGeneral: Story = {
  play: async ({ canvasElement, step }) => {
    const page = body(canvasElement);
    await step("The messages and the folded one show", async () => {
      await expect(await page.findByText("The last backup finished at 03:04 UTC on Friday. It took 2 GB and no errors were logged.")).toBeVisible();
      await userEvent.click((await page.findAllByRole("button", { name: /Slopbot did not read/ })).at(-1)!);
      await expect(await page.findByText("thanks")).toBeVisible();
    });
    await step("Conversations lists the channel's runs", async () => {
      await userEvent.click(page.getByRole("button", { name: "Conversations" }));
      await expect(await page.findByRole("button", { name: /Last backup/ })).toBeVisible();
    });
    await step("Picking one shows only that conversation", async () => {
      await userEvent.click(page.getByRole("button", { name: /Last backup/ }));
      await expect(await page.findByRole("button", { name: "Back to channel" })).toBeVisible();
    });
  },
};

/** Slopbot is answering a question Sam just asked; the answer streams in. */
export const SlopbotIsStillAnswering: Story = {
  parameters: { msw: { handlers: { channelEvents: engineStream("/api/conversations/:channel/events", data.channelLive(GENERAL), GENERAL) } } },
  play: async ({ canvasElement }) => {
    await expect(await body(canvasElement).findByText("@Slopbot can you check the orders table too?")).toBeVisible();
  },
};

/** Channel with no saved history. */
export const ChannelWithNoSavedHistory: Story = {
  parameters: { msw: { handlers: { channelMessages: http.get(messages, () => HttpResponse.json({ ...data.transcript(GENERAL), messages: [] })) } } },
  play: async ({ canvasElement }) => {
    await expect(await body(canvasElement).findByText("No messages yet.")).toBeVisible();
  },
};

/** Very long thread: the newest 200 messages with a button for older ones. */
export const VeryLongThread: Story = {
  parameters: { msw: { handlers: { channelMessages: http.get(messages, ({ params }) => HttpResponse.json(data.longTranscript(params.channel as string))) } } },
  play: async ({ canvasElement }) => {
    const page = body(canvasElement);
    await expect(await page.findByRole("button", { name: "Load older messages" })).toBeVisible();
    await waitFor(() => expect(page.getAllByText(/of the very long thread/).length).toBeGreaterThan(5));
  },
};

/** Web transcripts are off for the channel and the user manages the server, so they can turn them on. */
export const WebTranscriptsAreOff: Story = {
  parameters: { msw: { handlers: { conversations: http.get("/api/conversations", () => HttpResponse.json({ conversations: data.conversations.map((c) => (c.id === GENERAL ? { ...c, enabled: false } : c)) })) } } },
  play: async ({ canvasElement }) => {
    const page = body(canvasElement);
    await expect(await page.findByRole("heading", { name: "Web transcripts are off for this channel." })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Turn on web transcripts" }));
    await expect(await page.findByText("Web transcripts on for this channel.")).toBeVisible();
  },
};

/** The messages call fails. */
export const TranscriptDidNotLoad: Story = {
  parameters: { msw: { handlers: { channelMessages: http.get(messages, () => failure(403, "You cannot read this channel.")) } } },
  play: async ({ canvasElement }) => {
    await expect(await body(canvasElement).findByText("You cannot read this channel.")).toBeVisible();
  },
};

/** The messages call is slow. */
export const TranscriptIsLoading: Story = {
  parameters: { msw: { handlers: { channelMessages: forever(messages) } } },
};
