// The LLM mode from GET /api/status: a banner over the page while Slopbot runs on a backup model or its model service
// is down, and paused composers while the user cannot chat. Polled every 30 seconds, as the old console did.
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Alert } from "slop-ui-components";
import { get } from "./api";
import type { Status } from "./api-types";

// The texts match DEGRADED_NOTE and FALLBACK_NOTE in src/llm-mode.ts. tests/web-status.test.ts checks them.
export const DEGRADED_TEXT = "Slopbot is running at reduced capacity because its model service is down. Slash commands still work. Messages sent now will not be answered later.";
export const FALLBACK_TEXT = "Slopbot is running at reduced capacity on a backup model. Answers can be weaker.";
const PAUSED_TEXT = "Chat is paused while the model service is down.";
const NORMAL: Status = { mode: "normal", canChat: true };

/** A failed poll keeps the last answer. Signed-out pages (401) stop polling. */
export const statusQuery = queryOptions({
  queryKey: ["status"],
  queryFn: () => get<Status>("/api/status"),
  refetchInterval: (query) => ((query.state.error as { status?: number } | null)?.status === 401 ? false : 30_000),
  staleTime: 0,
});

export function useLlmStatus(): Status {
  return useQuery(statusQuery).data ?? NORMAL;
}

/** The banner for a backup model or a model service that is down. Draws nothing when all is well. */
export function LlmBanner() {
  const { mode } = useLlmStatus();
  if (mode === "normal") return null;
  return (
    <Alert tone={mode === "offline" ? "danger" : "warning"} className="m-3">
      {mode === "offline" ? DEGRADED_TEXT : FALLBACK_TEXT}
    </Alert>
  );
}

/** Composer props while the user cannot chat: the composer is off, with a note above it. */
export function usePausedComposer(): { isDisabled?: boolean; above?: React.ReactNode } {
  const { canChat } = useLlmStatus();
  return canChat ? {} : { isDisabled: true, above: <p className="px-3 pt-2 text-sm text-muted">{PAUSED_TEXT}</p> };
}
