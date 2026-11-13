import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { Button, Select, Switch, TextField } from "slop-ui-components";
import { SectionNote, SettingsGroup, SettingsRow } from "./layout";

/**
 * The parts of a Settings page, in claude.ai's style: `SettingsGroup` is a heading with an optional note and
 * actions, holding rows with dividers between them. `SettingsRow` puts the label and help on the left and the
 * control on the right (or under the text with `stack`). `SectionNote` stands in for a group's body when there is
 * nothing to show. The playground shows the group.
 */
const meta = {
  title: "Components/UI/Settings layout",
  component: SettingsGroup,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="max-w-xl"><Story /></div>],
  args: { children: null },
  argTypes: {
    title: { control: "text" },
    description: { control: "text" },
    actions: { control: false },
    children: { control: false },
  },
} satisfies Meta<typeof SettingsGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

const rows = (
  <>
    <SettingsRow label="Answer in threads" help="Slopbot replies in a new thread instead of the channel.">
      <Switch aria-label="Answer in threads" isSelected onChange={() => {}} />
    </SettingsRow>
    <SettingsRow label="Reply length">
      <Select aria-label="Reply length" variant="quiet" options={[{ id: "short", label: "Short" }, { id: "normal", label: "Normal" }]} value="normal" />
    </SettingsRow>
  </>
);

/** Every option of the group through the controls. */
export const Playground: Story = { args: { title: "Behavior", description: "How Slopbot answers in this server.", children: rows } };

/** The group variants side by side: with actions, a stacked row, and a note in place of the rows. */
export const Gallery: Story = {
  render: () => (
    <>
      <SettingsGroup title="With actions" actions={<Button size="sm">Add</Button>}>{rows}</SettingsGroup>
      <SettingsGroup title="Stacked row" description="Long fields go under the text.">
        <SettingsRow stack label="Instructions" help="Slopbot follows these in every chat.">
          <TextField aria-label="Instructions" multiline value="" rows={3} className="w-full" />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Nothing to show"><SectionNote>You need Manage Server to see this.</SectionNote></SettingsGroup>
    </>
  ),
};

/** A long label wraps in its own column; the switch keeps its size and stays in view. */
export const ReadingALongSettingName: Story = {
  decorators: [(Story) => <div className="w-72"><Story /></div>],
  render: () => (
    <SettingsGroup title="Behavior">
      <SettingsRow label="Answer in a new thread whenever a message in the channel mentions Slopbot" help="Turn off to answer in the channel.">
        <Switch aria-label="Answer in a new thread" isSelected={false} onChange={() => {}} />
      </SettingsRow>
    </SettingsGroup>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Answer in a new thread whenever/)).toBeVisible();
    await expect(canvas.getByRole("switch", { name: "Answer in a new thread" })).toBeVisible();
  },
};
