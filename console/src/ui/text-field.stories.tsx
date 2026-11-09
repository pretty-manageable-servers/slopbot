import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, userEvent, within } from "storybook/test";
import { NumberField, TextArea, TextField } from "./text-field";

/**
 * The console's text inputs. `TextField` is one line (text, url, password, search), `NumberField` a whole number and
 * `TextArea` several lines; all three share one look and the same props. They draw their label only with
 * `showLabel`: inside a settings row the row names the field, so the label is for screen readers. The playground
 * shows `TextField`; the gallery shows all three.
 */
const meta = {
  title: "Components/UI/Text field",
  component: TextField,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { label: "Display name", value: "", onChange: () => {}, showLabel: true },
  argTypes: {
    label: { control: "text" },
    showLabel: { control: "boolean" },
    value: { control: "text" },
    type: { control: "select", options: ["text", "url", "password", "number", "search"] },
    placeholder: { control: "text" },
    maxLength: { control: "number" },
    disabled: { control: "boolean" },
    required: { control: "boolean" },
    className: { control: "text" },
    autoComplete: { control: "text" },
    onChange: { control: false },
  },
  render: function Render(args) {
    const [, update] = useArgs();
    return <TextField {...args} className={args.className ?? "w-72"} onChange={(value) => update({ value })} />;
  },
} satisfies Meta<typeof TextField>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Every option of the field through the controls. */
export const Playground: Story = { args: { value: "DerpZ", placeholder: "Your name" } };

/** The three fields side by side, with a label, disabled, and a placeholder. */
export const Gallery: Story = {
  render: (args) => (
    <div className="flex w-80 flex-col gap-4">
      <TextField {...args} label="Server URL" showLabel type="url" value="" placeholder="https://" />
      <NumberField label="Daily limit" showLabel value={20} onChange={() => {}} />
      <TextArea label="Instructions" showLabel value="" rows={3} placeholder="Always answer in French." onChange={() => {}} />
      <TextField {...args} label="Locked" showLabel value="Cannot change" disabled />
    </div>
  ),
};

/** The daily limit needs a number: an empty box is NaN, and the caller blocks the save. */
export const TypingAnInvalidNumber: Story = {
  render: () => {
    const [limit, setLimit] = useState(20);
    return (
      <div className="flex flex-col gap-2">
        <NumberField label="Daily limit" showLabel value={limit} onChange={setLimit} />
        <p aria-live="polite" className="m-0 text-sm text-chat-muted">{Number.isNaN(limit) ? "Enter a number." : `Limit: ${limit}`}</p>
      </div>
    );
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByLabelText("Daily limit");
    await step("A number is passed on as a number", async () => {
      await userEvent.clear(box);
      await userEvent.type(box, "50");
      await expect(canvas.getByText(/Limit|Enter a number/)).toHaveTextContent("Limit: 50");
    });
    await step("An empty box is NaN", async () => {
      await userEvent.clear(box);
      await expect(canvas.getByText(/Limit|Enter a number/)).toHaveTextContent("Enter a number.");
    });
  },
};

/** Writing instructions: the text area stops at its character limit (20). */
export const WritingLongInstructions: Story = {
  render: () => {
    const [text, setText] = useState("");
    return (
      <div className="w-96">
        <TextArea label="Instructions" showLabel value={text} onChange={setText} maxLength={20} placeholder="Always answer in French." />
        <p className="m-0 mt-1 text-right text-sm text-chat-muted tabular-nums">{text.length} / 20</p>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Instructions"), "Answer briefly and in French, always.");
    await expect(canvas.getByLabelText("Instructions")).toHaveValue("Answer briefly and i");
  },
};

/** A search box: Escape clears it. */
export const ClearingASearch: Story = {
  render: () => {
    const [query, setQuery] = useState("");
    return <TextField label="Search settings" type="search" value={query} onChange={setQuery} placeholder="Search settings" className="w-72" />;
  },
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByRole("searchbox", { name: "Search settings" });
    await userEvent.type(box, "limits");
    await expect(box).toHaveValue("limits");
    await userEvent.keyboard("{Escape}");
    await expect(box).toHaveValue("");
  },
};
