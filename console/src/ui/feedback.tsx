// Short messages after an action (slop-ui-components toasts) and a confirm dialog for actions that delete things.
// Mount <FeedbackHost /> once; then call notify() and confirmAction() from anywhere.
import { ConfirmModal, Toaster, toast } from "slop-ui-components";
import { useEffect, useState } from "react";

interface Ask { title: string; body?: string; confirmLabel?: string; danger?: boolean; resolve: (ok: boolean) => void }

let ask: (request: Ask) => void = (request) => request.resolve(window.confirm(request.title));

/** Shows a message for a few seconds. Errors stay longer. */
export function notify(text: string, tone: "info" | "error" = "info") {
  toast(text, tone === "error" ? { tone: "danger", timeout: 8000 } : {});
}

/** The error text of a failed call as a notice. Use as `.catch(notifyError)` or in a mutation's onError. */
export const notifyError = (error: unknown) => notify(error instanceof Error ? error.message : String(error), "error");

/** Asks before a destructive action. Resolves true on confirm, false on cancel. */
export function confirmAction(request: Omit<Ask, "resolve">): Promise<boolean> {
  return new Promise((resolve) => ask({ ...request, resolve }));
}

/** Draws the toasts and the confirm dialog. Mount it once, inside the theme and router (the app shell and every story do). */
export function FeedbackHost() {
  const [request, setRequest] = useState<Ask | null>(null);
  useEffect(() => { ask = setRequest; }, []);
  const answer = (ok: boolean) => { request?.resolve(ok); setRequest(null); };
  return (
    <>
      <Toaster />
      <ConfirmModal isOpen={request !== null} onOpenChange={(open) => { if (!open) answer(false); }}
        title={request?.title ?? ""} description={request?.body} destructive={request?.danger ?? false}
        confirmLabel={request?.confirmLabel ?? "Confirm"} onConfirm={() => answer(true)} />
    </>
  );
}
