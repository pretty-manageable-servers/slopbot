import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { PageLoading, PageNote } from "./page-state";

/**
 * What a whole page shows in place of its content: `PageLoading` is the Slopbot loader while data arrives, and
 * `PageNote` is a sentence when the page cannot show (a failed load, no access, nothing joined yet). Both fill and
 * center in their parent, so the parent needs a height. The playground shows `PageNote`.
 */
const meta = {
  title: "Components/UI/Page states",
  component: PageNote,
  tags: ["autodocs"],
  decorators: [(Story) => <div className="h-80"><Story /></div>],
  args: { children: "This conversation is not available." },
  argTypes: {
    children: { control: "text", description: "The reason." },
    action: { control: false },
  },
} satisfies Meta<typeof PageNote>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Every option of the note through the controls. */
export const Playground: Story = {};

/** The two states, each in a box of its own. */
export const Gallery: Story = {
  render: (args) => (
    <div className="grid h-full grid-cols-2 gap-4">
      <div className="rounded-chat border border-chat-border"><PageLoading /></div>
      <div className="rounded-chat border border-chat-border"><PageNote {...args} action={<a href="/auth/login">Sign in with Discord</a>} /></div>
    </div>
  ),
};

/** The page is waiting for the bot: a loader, marked busy for screen readers. */
export const WaitingForAPage: Story = {
  render: () => <PageLoading />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[aria-busy='true']")).not.toBeNull();
  },
};

/** The session expired: the note says why and offers the way back in. */
export const SignedOut: Story = {
  args: { children: "Your session has ended." },
  render: (args) => <PageNote {...args} action={<a href="/auth/login">Sign in with Discord</a>} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Your session has ended.")).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Sign in with Discord" })).toHaveAttribute("href", "/auth/login");
  },
};
