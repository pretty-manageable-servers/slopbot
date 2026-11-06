// Short messages after an action (a toast at the bottom) and a confirm dialog for actions that delete things.
// Mount <FeedbackHost /> once; then call notify() and confirmAction() from anywhere.
import { Button, Modal } from "agentic-ui-kit";
import { useEffect, useState } from "react";

interface Toast { id: number; text: string; tone: "info" | "error" }
interface Ask { title: string; body?: string; confirmLabel?: string; danger?: boolean; resolve: (ok: boolean) => void }

let push: (toast: Omit<Toast, "id">) => void = () => {};
let ask: (request: Ask) => void = (request) => request.resolve(window.confirm(request.title));

/** Shows a message for a few seconds. Errors stay longer. */
export function notify(text: string, tone: Toast["tone"] = "info") { push({ text, tone }); }

/** The error text of a failed call as a notice. Use as `.catch(notifyError)` or in a mutation's onError. */
export const notifyError = (error: unknown) => notify(error instanceof Error ? error.message : String(error), "error");

/** Asks before a destructive action. Resolves true on confirm, false on cancel. */
export function confirmAction(request: Omit<Ask, "resolve">): Promise<boolean> {
  return new Promise((resolve) => ask({ ...request, resolve }));
}

export function FeedbackHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [request, setRequest] = useState<Ask | null>(null);
  useEffect(() => {
    let next = 0;
    push = (toast) => {
      const id = ++next;
      setToasts((list) => [...list.slice(-2), { ...toast, id }]);
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), toast.tone === "error" ? 8000 : 4000);
    };
    ask = setRequest;
  }, []);
  const answer = (ok: boolean) => { request?.resolve(ok); setRequest(null); };
  return (
    <>
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto max-w-md rounded-chat border bg-chat-popover px-4 py-2.5 text-sm shadow-chat-popover ${t.tone === "error" ? "border-chat-danger text-chat-fg" : "border-chat-popover-border"}`}>
            {t.text}
          </div>
        ))}
      </div>
      <Modal isOpen={request !== null} onOpenChange={(open) => { if (!open) answer(false); }} title={request?.title} className="max-w-md">
        {request?.body && <p className="m-0 px-5 text-sm text-chat-muted">{request.body}</p>}
        <div className="flex justify-end gap-2 px-5 pt-4 pb-4">
          <Button variant="ghost" onPress={() => answer(false)}>Cancel</Button>
          <Button variant={request?.danger ? "danger" : "primary"} onPress={() => answer(true)}>{request?.confirmLabel ?? "Confirm"}</Button>
        </div>
      </Modal>
    </>
  );
}
