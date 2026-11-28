// The console's pages under /console (TanStack Router, routes in code):
//   /                                     a new chat
//   /chat/$chatId                         a private chat
//   /server/$serverId                     the Servers view of one server: its Inbox
//   /server/$serverId/channel/$channelId  a channel or thread transcript; ?run=<id> opens one conversation of it
//   /projects                             the projects
//   /project/$projectId                   one project: its details, Instructions, Files, Memory and Chats
//   /memory                               your memory: what Slopbot remembers about you
//   /assistant                            Bud: its home chat, what waits for you, the sprouts and the activity
//   /assistant/task/$taskId               one sprout: its chat, rules, wake and effort
// Every page takes ?settings=<section> to open Settings over it. A new chat takes ?project=<id> to start in a project.
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AssistantPage } from "./assistant/assistant-page";
import { SproutPage } from "./assistant/sprout-page";
import { ChatPage } from "./chat-page";
import { MemoryPage } from "./memory/memory-page";
import { Layout } from "./layout";
import { ProjectPage } from "./projects/project-page";
import { ProjectsPage } from "./projects/projects-page";
import { ChannelPage } from "./servers/channel";
import { ServerHome } from "./servers/home";

export const BASE = "/console";

const optionalString = (value: unknown) => (typeof value === "string" && value ? value : undefined);

const rootRoute = createRootRoute({
  component: Layout,
  validateSearch: (search: Record<string, unknown>): { settings?: string } => {
    const settings = optionalString(search.settings);
    return settings ? { settings } : {};
  },
});
const newChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <ChatPage />,
  validateSearch: (search: Record<string, unknown>): { project?: string } => {
    const project = optionalString(search.project);
    return project ? { project } : {};
  },
});
export const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: "chat/$chatId", component: function Page() { const { chatId } = chatRoute.useParams(); return <ChatPage key={chatId} id={chatId} />; } });
export const serverRoute = createRoute({ getParentRoute: () => rootRoute, path: "server/$serverId", component: ServerHome });
export const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: "projects", component: ProjectsPage });
export const projectRoute = createRoute({ getParentRoute: () => rootRoute, path: "project/$projectId", component: function Page() { const { projectId } = projectRoute.useParams(); return <ProjectPage key={projectId} id={projectId} />; } });
export const memoryRoute = createRoute({ getParentRoute: () => rootRoute, path: "memory", component: MemoryPage });
export const assistantRoute = createRoute({ getParentRoute: () => rootRoute, path: "assistant", component: AssistantPage });
export const sproutRoute = createRoute({ getParentRoute: () => rootRoute, path: "assistant/task/$taskId", component: function Page() { const { taskId } = sproutRoute.useParams(); return <SproutPage key={taskId} id={taskId} />; } });
export const channelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "server/$serverId/channel/$channelId",
  component: ChannelPage,
  validateSearch: (search: Record<string, unknown>): { run?: string } => {
    const run = optionalString(search.run);
    return run ? { run } : {};
  },
});

export const routeTree = rootRoute.addChildren([newChatRoute, chatRoute, serverRoute, channelRoute, projectsRoute, projectRoute, memoryRoute, assistantRoute, sproutRoute]);

export const router = createRouter({
  routeTree,
  basepath: BASE,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
