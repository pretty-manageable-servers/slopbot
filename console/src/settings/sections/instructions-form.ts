// Rules for the Instructions form: how the length is counted, when Save is allowed, and the text for a save the bot
// rejected. The form itself is in instructions.tsx.
import { ApiError } from "../../api";

/** The length the bot checks: code points, so an emoji counts as one. */
export const instructionsLength = (text: string) => [...text].length;

/** Save is allowed when the draft differs from the saved text (an empty draft clears it), fits the limit and no save is running. */
export function canSave(draft: string, saved: string | null, max: number, pending: boolean): boolean {
  return !pending && draft !== (saved ?? "") && instructionsLength(draft) <= max;
}

/** The bot's reason for a rejected save (422), shown under the editor. Any other error is a toast instead. */
export function rejectMessage(error: unknown): string | null {
  return error instanceof ApiError && error.status === 422 ? error.message : null;
}
