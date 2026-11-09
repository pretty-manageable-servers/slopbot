// The frame every story draws in, as main.tsx draws the console: a fresh query client, the kit theme with the
// Slopbot icons, and a memory router. Parameters:
//   api:  routes of the fake bot (mock-api.ts), usually { ...baseRoutes, ...overrides }
//   path: the console path the story is at, e.g. "/server/100000000000000001". Default "/".
//   page: true draws the whole console (the real route tree) at `path` instead of the story's own render.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { Decorator } from "@storybook/react-vite";
import { ChatTheme } from "agentic-ui-kit";
import { RouterProvider as LinkRouter } from "react-aria-components";
import { useState, type ReactNode } from "react";
import { Loader, Logo } from "../logo";
import { routeTree } from "../router";
import { baseRoutes } from "./fixtures";
import { setRoutes, type Routes } from "./mock-api";

export interface ConsoleParameters { api?: Routes; path?: string; page?: boolean }

function storyRouter(path: string, page: boolean, render: () => ReactNode) {
  const history = createMemoryHistory({ initialEntries: [`/console${path}`] });
  if (page) return createRouter({ routeTree, history, basepath: "/console" });
  const root = createRootRoute({ component: render });
  // Any path matches, so links and navigation inside the story stay on it.
  return createRouter({ routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "$" })]), history, basepath: "/console" });
}

export const withConsole: Decorator = (Story, context) => {
  const { api = baseRoutes, path = "/", page = false } = (context.parameters.console ?? {}) as ConsoleParameters;
  setRoutes(api);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }));
  const [router] = useState(() => storyRouter(path, page, () => <Story />));
  return (
    <QueryClientProvider client={client}>
      <ChatTheme className="contents" icons={{ activity: <Loader size={18} />, activityDone: <Logo size={18} /> }}>
        <LinkRouter navigate={(href) => void router.history.push(href)}>
          {/* The memory router's types are not the app's registered router. */}
          <RouterProvider router={router as never} />
        </LinkRouter>
      </ChatTheme>
    </QueryClientProvider>
  );
};
