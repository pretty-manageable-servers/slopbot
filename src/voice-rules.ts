/** Rules for a voice turn. The reply is posted in chat and read aloud by text to speech. */
export const VOICE_RULE = "This request was spoken in a Discord voice channel and your reply is read aloud by text to speech. Reply in one to three short spoken sentences, at most 60 words. Use plain text: no markdown, lists, tables, code, emoji or URLs. Say numbers and names as words people say. If the full answer is long, give the key point and offer to post details. A voice channel has no task threads: never call task_start here.";
export const VOICE_SPOKEN_MAX = 600;
export const VOICE_CUE_TEXT = "One moment.";
export const VOICE_TURN_TIMEOUT_MS = 120_000;

/** Text for TTS: cut at the last . ! ? at or before max characters, else a hard cut. Trims. */
/** Spoken when a reply is an error report. The details stay in the chat. */
export const VOICE_ERROR_TEXT = "Sorry, that did not work. The details are in the chat.";

export function spokenText(text: string, max = VOICE_SPOKEN_MAX): string {
  // An error reply starts with a code such as [ACTION_UNCERTAIN]. Do not read it aloud.
  if (/^\s*\\?\[[A-Z][A-Z0-9\\_]*\]/.test(text)) return VOICE_ERROR_TEXT;
  // Markdown marks, links and URLs are not spoken.
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/<[@#&!]*\d+>/g, "").replace(/[\\*_`~#>|]/g, "").replace(/\s+/g, " ");
  const chars = Array.from(plain.trim());
  if (chars.length <= max) return chars.join("");
  const head = chars.slice(0, max);
  for (let i = head.length - 1; i >= 0; i--) {
    if (".!?".includes(head[i]!)) return head.slice(0, i + 1).join("").trim();
  }
  return head.join("").trim();
}
