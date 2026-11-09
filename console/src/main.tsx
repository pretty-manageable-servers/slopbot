import "./app.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ChatTheme } from "agentic-ui-kit";
import { RouterProvider as LinkRouter } from "react-aria-components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./data";
import { Loader, Logo } from "./logo";
import "./prefs";
import { router } from "./router";
import { stashAsk } from "./chat-page";

stashAsk();

// `pnpm dev:mock`: answer /api from the fake bot in src/mocks before the first call.
if (import.meta.env.VITE_MOCK_API) {
  const { worker } = await import("./mocks/browser");
  await worker.start({ serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` } });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* The Slopbot flower works left of "Thinking…" and tool steps, and rests there when they are done. */}
      <ChatTheme className="contents" icons={{ activity: <Loader size={18} />, activityDone: <Logo size={18} /> }}>
        {/* Kit links (chat and channel rows) carry full /console paths. Without this, react-aria lets the browser
            follow them, which reloads the whole page. */}
        <LinkRouter navigate={(href) => router.history.push(href)}>
          <RouterProvider router={router} />
        </LinkRouter>
      </ChatTheme>
    </QueryClientProvider>
  </StrictMode>,
);
