import type { Meta, StoryObj } from "@storybook/react-vite";
import { UiComponentsProvider, UiMarkupBlock } from "agentic-ui-kit/visuals";
import { expect, userEvent, within } from "storybook/test";
import { uiComponents } from "./ui-components";

interface Args {
  /** The inside of a ```ui block, as the model writes it with the show_ui tool. */
  markup: string;
}

/**
 * The components the model may draw in a reply with `show_ui`: Stack, Grid, Card, Heading, Text, Metric, List,
 * Checklist, Tabs, Show and Button. Their names and props come from the bot (`showUiSpecs` in
 * `@slopbot/contracts`); `src/ui-components.tsx` only gives each a look. Edit the markup in the controls to try them.
 */
const meta = {
  title: "Components/UI/Show UI components",
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { markup: "" },
  argTypes: { markup: { control: "text" } },
  render: ({ markup }) => (
    <UiComponentsProvider components={uiComponents}>
      <div className="max-w-xl"><UiMarkupBlock id="story" source={markup} /></div>
    </UiComponentsProvider>
  ),
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

const report = `<Card title="Server health" subtitle="Last 24 hours" tag="New" tone="accent">
  <Grid columns={3}>
    <Metric label="Uptime" value="99.9%" tone="good" />
    <Metric label="Requests" value={12840} note="+4% on yesterday" />
    <Metric label="Errors" value={7} tone="bad" />
  </Grid>
  <List items={[{ label: "Postgres", detail: "12 ms" }, { label: "Redis", detail: "1 ms", tag: "Changed" }]} />
</Card>`;

/** Any markup through the controls. */
export const Playground: Story = { args: { markup: report } };

/** Every component once. */
export const Gallery: Story = {
  args: {
    markup: `<Stack gap="lg">
  <Heading text="Heading" />
  <Text text="A paragraph of plain text." />
  <Text text="A muted note." tone="muted" />
  <Stack direction="row"><Metric label="Good" value="1" tone="good" /><Metric label="Warning" value="2" tone="warning" /><Metric label="Bad" value="3" tone="bad" /></Stack>
  <Card title="Card" subtitle="With a subtitle"><Text text="Inside a card." /></Card>
  <Checklist stateKey="todo" items={["First", "Second"]} />
  <Button label="Primary" variant="primary" onPress={{ "set": { "key": "x", "value": 1 } }} />
</Stack>`,
  },
};

/** The model offers a to-do list: ticking an item crosses it out and the tick is kept. */
export const TickingOffAChecklist: Story = {
  args: { markup: `<Card title="Before you deploy"><Checklist stateKey="deploy" items={["Run the tests", "Back up the database"]} /></Card>` },
  play: async ({ canvasElement }) => {
    const box = await within(canvasElement).findByRole("checkbox", { name: "Run the tests" });
    await userEvent.click(box);
    await expect(box).toBeChecked();
  },
};

/** Tabs switch what is shown without a new reply. */
export const SwitchingTabs: Story = {
  args: {
    markup: `<State tab="a" />
<Tabs stateKey="tab" value={$state.tab} options={[{ id: "a", label: "Summary" }, { id: "b", label: "Details" }]} />
<Show value={$state.tab} equals="a"><Text text="The summary." /></Show>
<Show value={$state.tab} equals="b"><Text text="The details." /></Show>`,
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step("The first tab shows", async () => {
      await expect(await canvas.findByText("The summary.")).toBeVisible();
    });
    await step("Details replaces the summary", async () => {
      await userEvent.click(canvas.getByRole("button", { name: "Details" }));
      await expect(await canvas.findByText("The details.")).toBeVisible();
      await expect(canvas.queryByText("The summary.")).toBeNull();
    });
  },
};
