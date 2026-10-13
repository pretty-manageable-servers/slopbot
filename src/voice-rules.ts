/** Rules for a voice turn. The reply is posted in chat and read aloud by text to speech. */
export const VOICE_RULE = "This request was spoken in a Discord voice channel and your reply is read aloud by text to speech. Reply in one to three short spoken sentences, at most 60 words. Use plain text: no markdown, lists, tables, code, emoji or URLs. Say numbers and names as words people say. If the full answer is long, give the key point and offer to post details.";
export const VOICE_SPOKEN_MAX = 600;
export const VOICE_CUE_TEXT = "One moment.";
export const VOICE_TURN_TIMEOUT_MS = 120_000;

/** Text for TTS: cut at the last . ! ? at or before max characters, else a hard cut. Trims. */
export function spokenText(text: string, max = VOICE_SPOKEN_MAX): string {
  return text.trim().slice(0, max); // WP2 replaces this stub.
}
