import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { Suspense } from "react";
import { expect, screen, userEvent, within } from "storybook/test";
import { CommandPalette } from "./palette";
import { failure } from "./mocks/handlers";

/**
 * The command palette: Ctrl+K or Cmd+K opens a search over chats, channels, servers, actions and, from two letters,
 * the messages of the picked server. Left and Right change the filter; Enter opens the row.
 */
const meta = {
  title: "Components/Chat/CommandPalette",
  component: CommandPalette,
  tags: ["autodocs"],
  decorators: [(Story) => <Suspense fallback={null}><Story /></Suspense>],
} satisfies Meta<typeof CommandPalette>;
export default meta;
type Story = StoryObj<typeof meta>;

const search = "/api/conversations/search";
const openPalette = async () => {
  await userEvent.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog", { name: "Command palette" });
};

/** The user opens the palette and finds a chat, a channel and the actions. */
export const FindAChatOrAnAction: Story = {
  play: async ({ step }) => {
    let palette!: HTMLElement;
    await step("Open with Ctrl+K", async () => { palette = await openPalette(); });
    await step("Recent chats and channels and the actions are listed", async () => {
      const results = within(await screen.findByRole("listbox", { name: "Results" }));
      await expect(await results.findByText("Why is my Postgres slow")).toBeVisible();
      await expect(results.getByText("Why is the build red")).toBeVisible();
      await expect(results.getByText("New chat")).toBeVisible();
    });
    await step("The Servers filter lists the servers", async () => {
      await userEvent.click(within(palette).getByRole("button", { name: "Servers" }));
      await expect(within(await screen.findByRole("listbox", { name: "Results" })).getByText("Second Lab")).toBeVisible();
    });
  },
};

/** The user searches message text and gets hits with the channel and author. */
export const SearchTheMessages: Story = {
  play: async () => {
    const palette = await openPalette();
    await userEvent.type(within(palette).getByRole("combobox"), "backup");
    await expect(await within(palette).findByText("general · Sam")).toBeVisible();
  },
};

/** Nothing matches the words typed. */
export const NothingMatches: Story = {
  parameters: { msw: { handlers: { search: http.get(search, () => HttpResponse.json({ query: "zzzz", channels: [], messages: [] })) } } },
  play: async () => {
    const palette = await openPalette();
    await userEvent.type(within(palette).getByRole("combobox"), "zzzz");
    await expect(await within(palette).findByText("No messages match")).toBeVisible();
  },
};

/** The message search fails; the other rows still work. */
export const MessageSearchIsDown: Story = {
  parameters: { msw: { handlers: { search: http.get(search, () => failure(500, "Search is down")) } } },
  play: async () => {
    const palette = await openPalette();
    await userEvent.type(within(palette).getByRole("combobox"), "backup");
    await expect(await within(palette).findByText("Search is down")).toBeVisible();
  },
};
