// Short messages after an action, as slop-ui-components toasts. Confirm dialogs are the library's confirm().
// Mount <FeedbackHost /> once; then call notify() and confirm() from anywhere.
import { ConfirmHost, Toaster, toast } from "slop-ui-components";

/** Shows a message for a few seconds. Errors stay longer. */
export function notify(text: string, tone: "info" | "error" = "info") {
  toast(text, tone === "error" ? { tone: "danger", timeout: 8000 } : {});
}

/** The error text of a failed call as a notice. Use as `.catch(notifyError)` or in a mutation's onError. */
export const notifyError = (error: unknown) => notify(error instanceof Error ? error.message : String(error), "error");

/** Draws the toasts and the confirm dialog. Mount it once, inside the theme and router (the app shell and every story do). */
export function FeedbackHost() {
  return <><Toaster /><ConfirmHost /></>;
}
