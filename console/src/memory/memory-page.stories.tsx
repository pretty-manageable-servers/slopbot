// Pages/Memory: what Slopbot remembers about the user, with search and the scope filter. There is no edit.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MemoryPage } from "./memory-page";

const meta = {
  title: "Pages/Memory",
  component: MemoryPage,
  tags: ["autodocs"],
  parameters: { route: "/memory", layout: "fullscreen" },
  decorators: [(Story) => <div className="h-dvh"><Story /></div>],
} satisfies Meta<typeof MemoryPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The memories with their scope and date, and a Delete button on each. */
export const ListsMemories: Story = {
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Each memory shows its text, and the count is shown", async () => {
      await expect(await page.findByText("Alice likes green tea.")).toBeVisible();
      await expect(page.getByText("The survey has 412 respondents; the response rate is 61 percent.")).toBeVisible();
      await expect(page.getByText("2 memories")).toBeVisible();
    });
    await step("The project memory names its project, and there is no edit", async () => {
      await expect(page.getByText(/Thesis · Updated/)).toBeVisible();
      await expect(page.queryByRole("button", { name: "Edit" })).toBeNull();
      await expect(page.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    });
  },
};

/** No memory yet: the page says what will be kept here. */
export const Empty: Story = {
  parameters: { msw: { handlers: { memories: http.get("/api/memories", () => HttpResponse.json({ items: [], total: 0 })) } } },
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("The empty state explains the page", async () => {
      await expect(await page.findByText("No memories yet")).toBeVisible();
    });
  },
};

/** A search keeps only the memories that match the text. A search with no match says so. */
export const Search: Story = {
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Typing a search keeps the matching memory", async () => {
      await expect(await page.findByText("Alice likes green tea.")).toBeVisible();
      await userEvent.type(page.getByRole("searchbox", { name: "Search memory" }), "tea");
      await waitFor(() => expect(page.queryByText("The survey has 412 respondents; the response rate is 61 percent.")).toBeNull());
      await expect(page.getByText("Alice likes green tea.")).toBeVisible();
      await expect(page.getByText("1 memory")).toBeVisible();
    });
    await step("A search with no match shows the no-match state", async () => {
      await userEvent.clear(page.getByRole("searchbox", { name: "Search memory" }));
      await userEvent.type(page.getByRole("searchbox", { name: "Search memory" }), "zebra");
      await expect(await page.findByText("No matches")).toBeVisible();
    });
  },
};

/** More memories than one page: the first 50 show, and Show more loads the rest. The button goes once all are shown. */
export const ShowMore: Story = {
  parameters: {
    msw: {
      handlers: {
        memories: http.get("/api/memories", ({ request }) => {
          const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
          const items = Array.from({ length: 120 }, (_, index) => ({ id: `m${index + 1}`, content: `Memory ${index + 1}.`, category: "fact" as const, tags: [], scope: "personal", updated: 1_800_000_000_000 }));
          return HttpResponse.json({ items: items.slice(offset, offset + 50), total: items.length });
        }),
      },
    },
  },
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("The first page shows 50 of 120, and Show more is there", async () => {
      await expect(await page.findByText("Memory 50.")).toBeVisible();
      await expect(page.queryByText("Memory 51.")).toBeNull();
      await expect(page.getByText("120 memories")).toBeVisible();
      await expect(page.getByRole("button", { name: "Show more" })).toBeVisible();
    });
    await step("Show more adds the next page, and stays while memories are left", async () => {
      await userEvent.click(page.getByRole("button", { name: "Show more" }));
      await expect(await page.findByText("Memory 100.")).toBeVisible();
      await expect(page.getByText("Memory 51.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Show more" })).toBeVisible();
    });
    await step("The last page loads, and the button goes", async () => {
      await userEvent.click(page.getByRole("button", { name: "Show more" }));
      await expect(await page.findByText("Memory 120.")).toBeVisible();
      await expect(page.queryByRole("button", { name: "Show more" })).toBeNull();
    });
  },
};
