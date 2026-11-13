import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, confirm } from "slop-ui-components";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { notify, notifyError } from "./feedback";

interface Args {
  /** The toast text. */
  text: string;
  /** `error` toasts get a red border and stay 8 seconds instead of 4. */
  tone: "info" | "error";
  /** The confirm dialog's title. */
  title: string;
  /** Explains what will be lost. */
  body: string;
  /** The confirm button's text. Defaults to "Confirm". */
  confirmLabel: string;
  /** Draws the confirm button in the danger style, for deletes. */
  danger: boolean;
}

/**
 * Short messages after an action and a confirm dialog before one that deletes things. Both are plain functions:
 * `notify(text, tone)` shows a toast, `notifyError(error)` shows a failed call's message, and
 * `confirm({ title, body, confirmLabel, danger })` returns a promise that resolves true on confirm and false
 * on cancel or Escape. `FeedbackHost` draws them and is mounted once in the app shell (and in every story). The
 * buttons here call the functions the way the console does.
 */
const meta = {
  title: "Components/UI/Toast and confirm",
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { text: "Settings saved.", tone: "info", title: "Revoke all share links?", body: "Everyone with a link loses access.", confirmLabel: "Revoke all", danger: true },
  argTypes: {
    text: { control: "text" },
    tone: { control: "inline-radio", options: ["info", "error"] },
    title: { control: "text" },
    body: { control: "text" },
    confirmLabel: { control: "text" },
    danger: { control: "boolean" },
  },
  render: (args) => (
    <div className="flex items-center gap-3">
      <Button variant="secondary" onPress={() => notify(args.text, args.tone)}>Show toast</Button>
      <Button variant="secondary" onPress={() => void confirm({ title: args.title, description: args.body, confirmLabel: args.confirmLabel, destructive: args.danger })}>Ask to confirm</Button>
    </div>
  ),
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

/** Every option of the toast and the dialog through the controls. */
export const Playground: Story = {};

/** The two toast tones one after the other. */
export const Gallery: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Button variant="secondary" onPress={() => notify("Settings saved.")}>Info toast</Button>
      <Button variant="secondary" onPress={() => notifyError(new Error("The bot could not be reached."))}>Error toast</Button>
    </div>
  ),
};

/** Revoking every share link cannot be undone, so the console asks first. Cancel keeps the links. */
export const ConfirmingADestructiveAction: Story = {
  render: function Render(args) {
    return (
      <Button variant="danger" onPress={() => void confirm({ title: args.title, description: args.body, confirmLabel: args.confirmLabel, destructive: true }).then((ok) => notify(ok ? "All links revoked." : "Nothing changed."))}>
        Revoke all
      </Button>
    );
  },
  play: async ({ canvasElement, step }) => {
    const open = async () => {
      await userEvent.click(within(canvasElement).getByRole("button", { name: "Revoke all" }));
      return await screen.findByRole("alertdialog", { name: "Revoke all share links?" });
    };
    await step("Cancel closes the dialog and changes nothing", async () => {
      const dialog = await open();
      await expect(within(dialog).getByText("Everyone with a link loses access.")).toBeVisible();
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Revoke all share links?" })).toBeNull());
      await expect(await screen.findByText("Nothing changed.")).toBeVisible();
    });
    await step("Confirm closes it and carries on", async () => {
      const dialog = await open();
      await userEvent.click(within(dialog).getByRole("button", { name: "Revoke all" }));
      await expect(await screen.findByText("All links revoked.")).toBeVisible();
    });
  },
};

/** A call failed: the message shows as an error toast, and the page behind it stays usable. */
export const ASaveFailed: Story = {
  render: () => <Button variant="primary" onPress={() => notifyError(new Error("Could not save: the bot is offline."))}>Save</Button>,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Save" }));
    await expect(await screen.findByText("Could not save: the bot is offline.")).toBeVisible();
  },
};
