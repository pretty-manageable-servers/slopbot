// Components/Settings dialog/Shared links: the Settings dialog open on the picked server's share links.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HttpResponse, http } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { threadShares } from "../../mocks/data";
import { failure, forever } from "../../mocks/handlers";
import { SettingsDialog } from "../dialog";

const meta: Meta = {
  title: "Components/Settings dialog/Shared links",
  render: () => <SettingsDialog />,
  parameters: { route: "/?settings=shares" },
};
export default meta;
type Story = StoryObj;

/** A manager opens the server's links, and Cancel keeps a link from being revoked. */
export const ManagerReviewsShareLinks: Story = {
  play: async ({ canvasElement, step }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await step("The links list their channel, status and actions", async () => {
      await expect(await dialog.findByRole("grid", { name: "Share links" })).toBeVisible();
      await expect(dialog.getByText("#general")).toBeVisible();
      await expect(dialog.getByText("Revoked")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Revoke all" })).toBeVisible();
    });
    await step("Revoking a link asks first, and Cancel keeps it", async () => {
      await userEvent.click(dialog.getAllByRole("button", { name: "Revoke" })[0]!);
      await expect(await dialog.findByText("Revoke this link?")).toBeVisible();
      await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(dialog.queryByText("Revoke this link?")).toBeNull(), { timeout: 3000 });
      await expect(dialog.getByRole("grid", { name: "Share links" })).toBeVisible();
    });
  },
};

/** The server has no links yet: the table says so and there is nothing to revoke. */
export const NoShareLinksYet: Story = {
  parameters: { msw: { handlers: { shares: http.get("/api/shares", () => HttpResponse.json({ shares: [] })) } } },
  play: async ({ canvasElement, step }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await step("The section says there are no links and offers no Revoke all", async () => {
      await expect(await dialog.findByText("No share links yet.")).toBeVisible();
      await expect(dialog.queryByRole("button", { name: "Revoke all" })).toBeNull();
    });
  },
};

/** Manage Server is missing on the picked server: the bot answers 403 and the section says what is needed. */
export const MemberWithoutManageServer: Story = {
  parameters: { msw: { handlers: { shares: http.get("/api/shares", () => failure(403, "Only server managers can manage share links.")) } } },
  play: async ({ canvasElement, step }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await step("The section explains that Manage Server is needed", async () => {
      await expect(await dialog.findByText("Manage Server permission is required to see share links.")).toBeVisible();
    });
  },
};

/** The bot cannot check permissions (Discord did not answer). The section shows the error, not a blank page. */
export const BotIsUnreachable: Story = {
  parameters: { msw: { handlers: { shares: http.get("/api/shares", () => failure(502, "Discord did not answer. Try again.")) } } },
  play: async ({ canvasElement, step }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await step("The section shows the bot's error", async () => {
      await expect(await dialog.findByText("Discord did not answer. Try again.")).toBeVisible();
    });
  },
};

/** The links are still on their way from the bot: the dialog stays open with no table yet. */
export const LinksAreLoading: Story = {
  parameters: { msw: { handlers: { shares: forever("/api/shares") } } },
  play: async ({ canvasElement, step }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await step("The dialog is open and no table is shown yet", async () => {
      await expect(await dialog.findByRole("heading", { name: "Settings" })).toBeVisible();
      await expect(dialog.queryByRole("grid")).toBeNull();
    });
  },
};

/** A link made from a thread: the thread is not in the channel list, so its ID stands in for the name. */
export const LinkFromAThreadShowsItsID: Story = {
  parameters: { msw: { handlers: { shares: http.get("/api/shares", () => HttpResponse.json({ shares: threadShares })) } } },
  play: async ({ canvasElement, step }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await step("The row shows the thread's ID in the channel column", async () => {
      await expect(await dialog.findByText("300000000000000099")).toBeVisible();
    });
  },
};
