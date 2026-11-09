import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { houseoverwatch, inbox } from "../mocks/data";
import { InboxList } from "./inbox";

/** The Inbox rows of one server: who asked, when, the summary, a link to the channel and Done. */
const meta = {
  title: "Components/Servers/InboxList",
  component: InboxList,
  tags: ["autodocs"],
  args: { server: houseoverwatch.id, items: inbox },
  argTypes: {
    server: { description: "The server the items belong to. Done writes to its inbox." },
    items: { control: "object", description: "The rows. Done items are dimmed and have no Done button. An empty list shows a note." },
  },
  decorators: [(Story) => <div className="mx-auto w-full max-w-2xl px-4"><Story /></div>],
} satisfies Meta<typeof InboxList>;
export default meta;
type Story = StoryObj<typeof meta>;

let posted: { ids: string[] } | undefined;

/** Open and done items, one sender with a very long name. Done posts the item's ID. */
export const Playground: Story = {
  parameters: { msw: { handlers: { inboxDone: http.post("/api/servers/:server/inbox/done", async ({ request }) => {
    posted = (await request.json()) as { ids: string[] };
    return HttpResponse.json({ changed: 1 });
  }) } } },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step("The done item is marked and has no button", async () => {
      await expect(canvas.getAllByRole("button", { name: "Done" })).toHaveLength(2);
      await expect(canvas.getByText("Done", { selector: "span" })).toBeVisible();
    });
    await step("Done on the first item posts its ID", async () => {
      await userEvent.click(canvas.getAllByRole("button", { name: "Done" })[0]!);
      await waitFor(() => expect(posted).toEqual({ ids: ["i1"] }));
    });
  },
};

/** Inbox is empty. */
export const InboxIsEmpty: Story = {
  args: { items: [] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Your inbox is empty.")).toBeVisible();
  },
};
