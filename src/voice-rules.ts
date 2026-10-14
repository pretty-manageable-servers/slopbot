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

/** Server setting that holds the TTS voice instructions. Empty or unset means the default. */
export const VOICE_INSTRUCTIONS_KEY = "voice_instructions";
export const VOICE_INSTRUCTIONS_MAX = 1000;
/** Used when neither the server setting nor env VOICE_INSTRUCTIONS is set. */
export const DEFAULT_VOICE_INSTRUCTIONS = "A calm, clear adult man with a low voice and a dry, friendly delivery.";
/** The instructions sent with each speech request for a server. */
export function voiceInstructions(setting: string | undefined, envDefault?: string): string {
  return setting?.trim() || envDefault?.trim() || DEFAULT_VOICE_INSTRUCTIONS;
}

/**
 * Splits streamed reply text into sentences for speech. push() returns the sentences that are complete;
 * flush() returns the rest. A sentence ends at . ! ? followed by a space or newline, or at a blank line.
 * WP-S2 implements it.
 */
export class SentenceSplitter {
  push(_delta: string): string[] { return []; }
  flush(): string[] { return []; }
}
