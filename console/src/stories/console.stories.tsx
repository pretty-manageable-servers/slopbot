// The whole console at a few pages, on the fake bot. For one part alone see the stories next to it.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { baseRoutes, servers } from "./fixtures";

const meta: Meta = { title: "Console/Pages", render: () => <></> };
export default meta;
type Story = StoryObj;

export const NewChat: Story = { parameters: { console: { page: true, path: "/" } } };
export const ServerInbox: Story = { parameters: { console: { page: true, path: `/server/${servers[0]!.id}` } } };
export const SettingsSharedLinks: Story = {
  parameters: { console: { page: true, path: "/?settings=shares", api: { ...baseRoutes, "GET /api/shares": { shares: [
    { id: "s1aaaaaaaaaaaaaaaaaa", channel: "300000000000000001", created_at: Date.UTC(2026, 10, 1), revoked: false },
    { id: "s2aaaaaaaaaaaaaaaaaa", channel: "300000000000000002", created_at: Date.UTC(2026, 9, 20), revoked: true },
  ] } } } },
};
