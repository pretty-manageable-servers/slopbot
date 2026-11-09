import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, userEvent, within } from "storybook/test";
import { SettingsGroup, SettingsRow } from "./layout";
import { Switch } from "./switch";

/**
 * An on/off switch for a setting that applies at once. It draws no text: the row beside it shows the words and
 * `label` names the switch for screen readers. The caller owns the state (`checked` and `onChange`).
 */
const meta = {
  title: "Components/UI/Switch",
  component: Switch,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { label: "Answer in threads", checked: false, onChange: () => {} },
  argTypes: {
    label: { control: "text" },
    checked: { control: "boolean" },
    disabled: { control: "boolean" },
    onChange: { control: false },
  },
  // The args hold the state, so the switch flips in the canvas as well as through the controls.
  render: function Render(args) {
    const [, update] = useArgs();
    return <Switch {...args} onChange={(checked) => update({ checked })} />;
  },
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Every option of the switch through the controls. */
export const Playground: Story = {};

/** The states side by side. */
export const Gallery: Story = {
  render: (args) => (
    <div className="flex items-center gap-6">
      <Switch {...args} label="Off" checked={false} />
      <Switch {...args} label="On" checked />
      <Switch {...args} label="Off, disabled" checked={false} disabled />
      <Switch {...args} label="On, disabled" checked disabled />
    </div>
  ),
};

/** The usual place: the right of a settings row, which names it. */
export const TurningOnASetting: Story = {
  render: (args) => {
    const [on, setOn] = useState(false);
    return (
      <div className="w-[28rem]">
        <SettingsGroup>
          <SettingsRow label="Answer in threads" help="Slopbot replies in a new thread instead of the channel.">
            <Switch {...args} label="Answer in threads" checked={on} onChange={setOn} />
          </SettingsRow>
        </SettingsGroup>
      </div>
    );
  },
  play: async ({ canvasElement, step }) => {
    const toggle = within(canvasElement).getByRole("switch", { name: "Answer in threads" });
    await step("It starts off", async () => {
      await expect(toggle).not.toBeChecked();
    });
    await step("Click turns it on, Space turns it off", async () => {
      await userEvent.click(toggle);
      await expect(toggle).toBeChecked();
      await userEvent.keyboard(" ");
      await expect(toggle).not.toBeChecked();
    });
  },
};

/** A disabled switch ignores clicks, e.g. while the setting saves. */
export const WhileSaving: Story = {
  args: { disabled: true, checked: true },
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("switch");
    await userEvent.click(toggle);
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeDisabled();
  },
};
