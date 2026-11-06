// The console's pages under /console/next (TanStack Router, routes in code):
//   /                                     a new chat
//   /chat/$chatId                         a private chat
//   /server/$serverId                     the Servers view of one server: its Inbox
//   /server/$serverId/channel/$channelId  a channel or thread transcript; ?run=<id> opens one conversation of it
// Every page takes ?settings=<section> to open Settings over it.
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { ChatPage } from "./chat-page";
import { Layout } from "./layout";
import { ChannelPage } from "./servers/channel";
import { ServerHome } from "./servers/home";

export const BASE = "/console/next";

const optionalString = (value: unknown) => (typeof value === "string" && value ? value : undefined);

const rootRoute = createRootRoute({
  component: Layout,
  validateSearch: (search: Record<string, unknown>): { settings?: string } => {
    const settings = optionalString(search.settings);
    return settings ? { settings } : {};
  },
});
const newChatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <ChatPage /> });
export const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: "chat/$chatId", component: function Page() { const { chatId } = chatRoute.useParams(); return <ChatPage key={chatId} id={chatId} />; } });
export const serverRoute = createRoute({ getParentRoute: () => rootRoute, path: "server/$serverId", component: ServerHome });
export const channelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "server/$serverId/channel/$channelId",
  component: ChannelPage,
  validateSearch: (search: Record<string, unknown>): { run?: string } => {
    const run = optionalString(search.run);
    return run ? { run } : {};
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([newChatRoute, chatRoute, serverRoute, channelRoute]),
  basepath: BASE,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
