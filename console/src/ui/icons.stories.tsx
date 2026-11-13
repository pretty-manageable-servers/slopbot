import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { icons } from "./icons";

type Name = keyof typeof icons;
const names = Object.keys(icons) as Name[];

interface Args {
  /** Which icon of the `icons` set to draw. */
  name: Name;
}

/**
 * The console's own line icons for the Settings nav and the drawer toggle: 16px on a 24 grid with a 1.75 stroke,
 * like the kit's, drawn in `currentColor` so they follow the text color. They are decorative (`aria-hidden`); the
 * label next to them is the name. Elsewhere the console uses lucide at 16px.
 */
const meta = {
  title: "Components/UI/Icons",
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { name: "account" },
  argTypes: { name: { control: "select", options: names } },
  render: ({ name }) => <span className="text-chat-fg [&_svg]:size-8">{icons[name]}</span>,
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

/** One icon, chosen by name, enlarged. */
export const Playground: Story = {};

/** Every icon with its name, in muted and normal text color. */
export const Gallery: Story = {
  render: () => (
    <ul className="m-0 grid list-none grid-cols-4 gap-x-8 gap-y-3 p-0 text-sm">
      {names.map((name) => (
        <li key={name} className="flex items-center gap-2">
          <span className="text-chat-fg">{icons[name]}</span>
          <span className="text-chat-muted">{name}</span>
        </li>
      ))}
    </ul>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("listitem")).toHaveLength(names.length);
  },
};
