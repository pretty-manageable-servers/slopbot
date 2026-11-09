import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { SettingsGroup, SettingsRow } from "./layout";
import { Select, type Option } from "./select";

/**
 * A dropdown for one choice among a few: the chosen label sits on the right with a caret, as in claude.ai's
 * settings. It opens the console's menu with the current choice checked. The select draws no label of its own;
 * `label` names it, and the settings row beside it shows the words.
 */
const meta = {
  title: "Components/UI/Select",
  component: Select<string>,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { label: "Reply length", options: [], value: "", onChange: () => {} },
  argTypes: {
    label: { control: "text" },
    options: { control: "object" },
    value: { control: "text", description: "The `id` of the chosen option." },
    disabled: { control: "boolean" },
    className: { control: "text" },
    onChange: { control: false },
  },
  render: function Render(args) {
    const [, update] = useArgs();
    return <Select {...args} onChange={(value) => update({ value })} />;
  },
} satisfies Meta<typeof Select<string>>;
export default meta;
type Story = StoryObj<typeof meta>;

const lengths: Option<string>[] = [
  { id: "short", label: "Short" },
  { id: "normal", label: "Normal" },
  { id: "long", label: "Long" },
];

const themes: Option<string>[] = [
  { id: "system", label: "Match system", description: "Follows your device." },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

/** Every option of the select through the controls. */
export const Playground: Story = { args: { options: lengths, value: "normal" } };

/** The states side by side: plain, with descriptions, disabled, and a value that is not in the list. */
export const Gallery: Story = {
  render: (args) => (
    <div className="flex items-center gap-4">
      <Select {...args} label="Plain" options={lengths} value="normal" />
      <Select {...args} label="With descriptions" options={themes} value="system" />
      <Select {...args} label="Disabled" options={lengths} value="long" disabled />
      <Select {...args} label="Unknown value" options={lengths} value="custom" />
    </div>
  ),
};

/** Picking a theme in settings: open the list, choose Light, the select shows it. */
export const ChoosingAnotherTheme: Story = {
  render: (args) => {
    const [theme, setTheme] = useState("system");
    return (
      <div className="w-[28rem]">
        <SettingsGroup>
          <SettingsRow label="Theme" help="Applies to this browser.">
            <Select {...args} label="Theme" options={themes} value={theme} onChange={setTheme} />
          </SettingsRow>
        </SettingsGroup>
      </div>
    );
  },
  play: async ({ canvasElement, step }) => {
    await step("Open the list; the current choice is checked", async () => {
      await userEvent.click(within(canvasElement).getByRole("button", { name: "Theme" }));
      await expect(await screen.findByRole("menuitemradio", { name: /Match system/ })).toBeChecked();
    });
    await step("Choose Light", async () => {
      await userEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));
      await waitFor(() => expect(within(canvasElement).getByRole("button", { name: "Theme" })).toHaveTextContent("Light"));
    });
  },
};
