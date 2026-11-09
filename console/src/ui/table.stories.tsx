import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "agentic-ui-kit";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { Table, type Column } from "./table";

interface ShareRow { id: string; channel: string; views: number; status: "Active" | "Revoked" }

/**
 * The console's one table, as in claude.ai's connector list: muted headers and a divider under each row. It draws
 * what it is given in the order it is given, so the caller sorts and filters. `columns` say how to draw each cell;
 * `align: "right"` also turns on tabular numbers. Use `font-mono` in a column's `className` for IDs.
 */
const meta = {
  title: "Components/UI/Table",
  component: Table<ShareRow>,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { label: "Share links", columns: [], rows: [], rowKey: (row) => row.id },
  argTypes: {
    label: { control: "text" },
    empty: { control: "text" },
    columns: { control: false },
    rows: { control: "object" },
    rowKey: { control: false },
    onRowPress: { control: false },
  },
} satisfies Meta<typeof Table<ShareRow>>;
export default meta;
type Story = StoryObj<typeof meta>;

const columns: Column<ShareRow>[] = [
  { id: "id", label: "Link", cell: (row) => row.id, className: "font-mono" },
  { id: "channel", label: "Channel", cell: (row) => row.channel },
  { id: "views", label: "Views", align: "right", cell: (row) => row.views.toLocaleString("en-US") },
  { id: "status", label: "Status", cell: (row) => <span className={row.status === "Revoked" ? "text-chat-muted" : ""}>{row.status}</span> },
  { id: "actions", label: "Actions", hideLabel: true, align: "right", cell: (row) => <Button size="sm" variant="subtle" isDisabled={row.status === "Revoked"}>Revoke</Button> },
];

const rows: ShareRow[] = [
  { id: "s1aaaaaaaaaaaaaaaaaa", channel: "#general", views: 1280, status: "Active" },
  { id: "s2aaaaaaaaaaaaaaaaaa", channel: "#memes", views: 42, status: "Revoked" },
  { id: "s3aaaaaaaaaaaaaaaaaa", channel: "#homelab", views: 7, status: "Active" },
];

const manyRows: ShareRow[] = Array.from({ length: 40 }, (_, i) => ({
  id: `s${String(i + 1).padStart(2, "0")}aaaaaaaaaaaaaaaaa`,
  channel: ["#general", "#memes", "#homelab", "#support"][i % 4]!,
  views: (i * 137) % 900,
  status: i % 5 === 0 ? "Revoked" : "Active",
}));

/** Every option of the table through the controls. */
export const Playground: Story = { args: { columns, rows, empty: "No share links yet." } };

/** The table's modes side by side: plain, clickable rows, and the empty note. */
export const Gallery: Story = {
  render: (args) => (
    <div className="flex flex-col gap-8">
      <Table {...args} label="Plain" columns={columns.slice(0, 3)} rows={rows} />
      <Table {...args} label="Clickable rows" columns={columns.slice(0, 3)} rows={rows} onRowPress={() => {}} />
      <Table {...args} label="Empty" columns={columns} rows={[]} empty="No share links yet." />
    </div>
  ),
};

/** The list can be long. A row opens on click or Enter. */
export const ScrollingThroughManyShareLinks: Story = {
  args: { columns, rows: manyRows },
  render: (args) => {
    const [open, setOpen] = useState<string | null>(null);
    return (
      <>
        <p aria-live="polite" className="m-0 mb-3 text-sm text-chat-muted">{open ? `Opened ${open}` : "Pick a link to open it."}</p>
        <Table {...args} onRowPress={(row) => setOpen(row.id)} />
      </>
    );
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step("All 40 links are listed", async () => {
      await expect(canvas.getAllByRole("row")).toHaveLength(41);
    });
    await step("Open one with the keyboard", async () => {
      const row = canvas.getByRole("row", { name: /s30aaaaaaaaaaaaaaaaa/ });
      row.focus();
      await userEvent.keyboard("{Enter}");
      await expect(canvas.getByText(/Opened/)).toHaveTextContent("Opened s30aaaaaaaaaaaaaaaaa");
    });
  },
};

/** A new server has no links: a quiet line replaces the table. */
export const NothingHereYet: Story = {
  args: { columns, rows: [], empty: "No share links yet." },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No share links yet.")).toBeVisible();
    await expect(canvas.queryByRole("table")).toBeNull();
  },
};

/** A long unbroken value (a URL) scrolls the table sideways inside its box instead of breaking the page. */
export const VeryLongCellText: Story = {
  args: {
    columns: [
      { id: "id", label: "Link", cell: (row) => row.id, className: "font-mono" },
      { id: "channel", label: "Channel", cell: (row) => row.channel },
      { id: "views", label: "Views", align: "right", cell: (row) => row.views },
    ],
    rows: [
      { id: "s1aaaaaaaaaaaaaaaaaa", channel: "https://example.com/a/very/long/path/that/never/breaks/because/it/has/no/spaces/at/all/and/keeps/going", views: 3, status: "Active" },
      ...rows.slice(1),
    ],
  },
  decorators: [(Story) => <div className="w-80"><Story /></div>],
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector<HTMLElement>(".overflow-x-auto")!;
    await expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
    // The box scrolls by keyboard, so it is focusable.
    await expect(box).toHaveAttribute("tabindex", "0");
  },
};
