// The public share page (/s/<id>). The bot puts the frozen copy in #share-data (sharePageData in src/shares.ts);
// share-view.tsx draws it. This file mounts it.
import "./app.css";
import "./prefs";
import { ChatTheme } from "agentic-ui-kit";
import type { ShareData } from "@slopbot/contracts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Loader, Logo } from "./logo";
import { SharePage } from "./share-view";

function readData(): ShareData | undefined {
  try { return JSON.parse(document.getElementById("share-data")?.textContent ?? "") as ShareData; } catch { return undefined; }
}

const data = readData();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatTheme className="contents" icons={{ activity: <Loader size={18} />, activityDone: <Logo size={18} /> }}>
      {data ? <SharePage data={data} /> : <p className="p-6 text-muted">This shared conversation could not be read.</p>}
    </ChatTheme>
  </StrictMode>,
);
