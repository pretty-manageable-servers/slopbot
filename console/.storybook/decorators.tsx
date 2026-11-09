// What every story draws in, as main.tsx draws the console: the theme on <html>, a fresh query client, the kit
// theme with the Slopbot icons, and a memory router. Parameters:
//   route: the console path the story is at, e.g. "/server/100000000000000001". Default "/".
//   app:   true draws the whole console (the real route tree and its shell) at `route` instead of the story.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { Decorator } from "@storybook/react-vite";
import { ChatTheme } from "agentic-ui-kit";
import { RouterProvider as LinkRouter } from "react-aria-components";
import { useState, type ReactNode } from "react";
import { Loader, Logo } from "../src/logo";
import { routeTree } from "../src/router";
import { themeIcons } from "../src/ui/sidebar";

export type Theme = "dark" | "light";
export interface ConsoleParameters { route?: string; app?: boolean }

function storyRouter(route: string, app: boolean, render: () => ReactNode) {
  const history = createMemoryHistory({ initialEntries: [`/console${route}`] });
  if (app) return createRouter({ routeTree, history, basepath: "/console" });
  const root = createRootRoute({ component: render });
  // Any path matches, so links and navigation inside the story stay on it.
  return createRouter({ routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "$" })]), history, basepath: "/console" });
}

/** The theme toolbar: dark is the console's default; light sets data-chat-theme on <html>, as prefs.ts does. */
export const withTheme: Decorator = (Story, { globals }) => {
  const root = document.documentElement;
  if (globals.theme === "light") root.dataset.chatTheme = "light";
  else delete root.dataset.chatTheme;
  return <Story />;
};

export const withConsole: Decorator = (Story, { parameters }) => {
  const { route = "/", app = false } = parameters as ConsoleParameters;
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }));
  const [router] = useState(() => storyRouter(route, app, () => <Story />));
  return (
    <QueryClientProvider client={client}>
      <ChatTheme className="contents" icons={{ ...themeIcons, activity: <Loader size={18} />, activityDone: <Logo size={18} /> }}>
        <LinkRouter navigate={(href) => void router.history.push(href)}>
          {/* The memory router's types are not the app's registered router. */}
          <RouterProvider router={router as never} />
        </LinkRouter>
      </ChatTheme>
    </QueryClientProvider>
  );
};
