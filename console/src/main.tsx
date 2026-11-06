import "./app.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ChatTheme } from "agentic-ui-kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./data";
import { Loader, Logo } from "./logo";
import "./prefs";
import { router } from "./router";
import { stashAsk } from "./chat-page";

stashAsk();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* The Slopbot flower works left of "Thinking…" and tool steps, and rests there when they are done. */}
      <ChatTheme className="contents" icons={{ activity: <Loader size={18} />, activityDone: <Logo size={18} /> }}>
        <RouterProvider router={router} />
      </ChatTheme>
    </QueryClientProvider>
  </StrictMode>,
);
