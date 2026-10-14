/** Rules for a voice turn. The reply is posted in chat and read aloud by text to speech. */
export const VOICE_RULE = "This request was spoken in a Discord voice channel. Call voice_say with what to say aloud (short spoken sentences in plain words, up to about 150 words, about one minute; shorter when a short answer is enough). Before a slow tool you may first call voice_say with one short line on what you will do. After tools, call voice_say again with the answer, or put the spoken answer in the reply inside <speak>...</speak> (plain words, removed from the chat post). Then write the full answer for the chat; it is not read aloud, so it may contain code, links and details. Task threads for voice requests open in the text channel where Slopbot was asked to join. If the transcript is only noise, a filler word or cut-off speech with no request, call voice_skip and write no reply.";
/** Hard limit of spoken characters per turn: about 80 seconds. The prompt asks for about 150 words (one minute), so this leaves some room. */
export const VOICE_SPOKEN_MAX = 2000;
/** Fillers spoken in order when a turn is silent while the bot works. */
export const VOICE_FILLER_TEXTS = ["One moment.", "Still working on it.", "Almost there."] as const;
/** Silence, in ms, before a filler is spoken. */
export const VOICE_FILLER_GAP_MS = 8000;
export const VOICE_FILLER_MAX = 3;
export const VOICE_TURN_TIMEOUT_MS = 120_000;
/** Spoken when a reply is an error report. The details stay in the chat. */
export const VOICE_ERROR_TEXT = "Sorry, that did not work. The details are in the chat.";

/** Fallback skip: a voice reply with "[SKIP]" anywhere means the turn is skipped. Nothing is posted or spoken. */
export const VOICE_SKIP = "[SKIP]";
const SKIP_MARKER = /\\?\[\s*skip\s*\\?\]/i;
/** The marker as it may be written: plain or with the markdown escape. Lower case. */
const SKIP_MARKERS = ["[skip]", "\\[skip\\]"];

/** True when the text contains the skip marker. */
export function containsSkipMarker(text: string): boolean {
  return SKIP_MARKER.test(text);
}

/**
 * Length of the end of `text` that might be the start of a skip marker, such as "[" or "\[S".
 * Streamed text holds this part back until a later delta shows whether it is a marker.
 */
export function heldSkipLength(text: string): number {
  const lower = text.toLowerCase();
  const longest = Math.max(...SKIP_MARKERS.map(marker => marker.length)) - 1;
  for (let length = Math.min(lower.length, longest); length > 0; length--) {
    const tail = lower.slice(lower.length - length);
    if (SKIP_MARKERS.some(marker => marker.length > length && marker.startsWith(tail))) return length;
  }
  return 0;
}

/**
 * Length of the end of `text` that might be the start of `tag`, such as "<sp" for "<speak>". `tag` is lower case.
 * Streamed text holds this part back until a later delta shows whether it is the tag.
 */
export function heldTagLength(text: string, tag: string): number {
  for (let length = Math.min(text.length, tag.length - 1); length > 0; length--) {
    if (text.slice(text.length - length).toLowerCase() === tag.slice(0, length)) return length;
  }
  return 0;
}

/** An error reply starts with a code such as [ACTION_UNCERTAIN]. Its text is not read aloud. A skip is not an error. */
export function isErrorReply(text: string): boolean {
  if (containsSkipMarker(text)) return false;
  return /^\s*\\?\[[A-Z][A-Z0-9\\_]*\]/.test(text);
}

/** Text without markdown marks, links, URLs, mentions or extra spaces. Trimmed. */
export function plainSpoken(text: string): string {
  // Channel links become words: "in <#id>" is the task thread, any other is the channel. This runs before mentions are dropped.
  return text.replace(/\bin <#\d+>/g, "in the thread").replace(/<#\d+>/g, "the channel").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/<[@#&!]*\d+>/g, "").replace(/[\\*_`~#>|]/g, "").replace(/\s+/g, " ").trim();
}

/** Plain text for TTS: cut at the last . ! ? at or before max characters, else a hard cut. Trims. */
export function cutSpoken(plain: string, max: number): string {
  const chars = Array.from(plain);
  if (chars.length <= max) return chars.join("");
  const head = chars.slice(0, max);
  for (let i = head.length - 1; i >= 0; i--) {
    if (".!?".includes(head[i]!)) return head.slice(0, i + 1).join("").trim();
  }
  return head.join("").trim();
}

/** Text for TTS: an error code gives VOICE_ERROR_TEXT; otherwise plain text cut to max characters. */
export function spokenText(text: string, max = VOICE_SPOKEN_MAX): string {
  if (containsSkipMarker(text)) return "";
  if (isErrorReply(text)) return VOICE_ERROR_TEXT;
  return cutSpoken(plainSpoken(text), max);
}

/** Server setting that holds the TTS voice instructions. Empty or unset means the default. */
export const VOICE_INSTRUCTIONS_KEY = "voice_instructions";
export const VOICE_INSTRUCTIONS_MAX = 1000;
/** Used when neither the server setting nor env VOICE_INSTRUCTIONS is set. */
export const DEFAULT_VOICE_INSTRUCTIONS = "A clear, warm young adult American woman with a medium pitch, a smooth and even pace, crisp articulation and a calm, friendly, helpful assistant tone.";
/** The instructions sent with each speech request for a server. */
/** The TTS voice name when VOICE_NAME is not set. Any other name is a voice preset on the TTS server. */
export const VOICE_NAME_DEFAULT = "alloy";
/**
 * The instructions sent with each speech request for a server. A voice preset (VOICE_NAME) fixes the voice by itself,
 * so then only a server's own style or VOICE_INSTRUCTIONS is sent, never the built-in default. Empty means none.
 */
export function voiceInstructions(setting: string | undefined, envDefault?: string, preset = false): string {
  return setting?.trim() || envDefault?.trim() || (preset ? "" : DEFAULT_VOICE_INSTRUCTIONS);
}

const CLOSERS = "\"')]}”’»";
const ABBREVIATIONS = new Set(["e.g", "i.e", "mr", "mrs", "ms", "dr", "vs", "prof", "jr", "sr"]);
const SHORT_PIECE = 20;

/**
 * Splits streamed reply text into sentences for speech. push() returns the sentences that are complete;
 * flush() returns the rest. A sentence ends at . ! ? (optionally with closing quotes or brackets) followed by
 * whitespace, or at a newline. Common abbreviations and decimals do not end a sentence. A piece shorter than
 * 20 characters joins the next sentence; flush() does not join.
 */
export class SentenceSplitter {
  private pending = "";
  private carry = "";

  push(delta: string): string[] {
    this.pending += delta;
    const out: string[] = [];
    let start = 0;
    let i = 0;
    while (i < this.pending.length) {
      const c = this.pending[i]!;
      let stop = -1, resume = -1;
      if (c === "\n") { stop = i; resume = i + 1; }
      else if (".!?".includes(c)) {
        let j = i + 1;
        while (j < this.pending.length && CLOSERS.includes(this.pending[j]!)) j++;
        // The text after the mark is not known yet. Wait for more text.
        if (j >= this.pending.length) break;
        if (/\s/.test(this.pending[j]!) && !(c === "." && isAbbreviation(this.pending.slice(start, i)))) { stop = j; resume = j; }
      }
      if (stop < 0) { i++; continue; }
      this.take(this.pending.slice(start, stop), out);
      start = resume; i = resume;
    }
    this.pending = this.pending.slice(start);
    return out;
  }

  flush(): string[] {
    const rest = this.pending;
    this.pending = "";
    const piece = [this.carry, rest.trim()].filter(Boolean).join(" ");
    this.carry = "";
    return piece ? [piece] : [];
  }

  private take(text: string, out: string[]): void {
    const piece = [this.carry, text.trim()].filter(Boolean).join(" ");
    this.carry = "";
    if (!piece) return;
    if (Array.from(piece).length < SHORT_PIECE) this.carry = piece;
    else out.push(piece);
  }
}

/** True when the text ends with a known abbreviation such as "e.g" or "Dr" (the dot is not included). */
function isAbbreviation(before: string): boolean {
  const token = /[A-Za-z.]+$/.exec(before)?.[0].toLowerCase();
  return token !== undefined && ABBREVIATIONS.has(token);
}

/** The spoken block of a voice reply: <speak>...</speak>. */
export const SPEAK_BLOCK = /<speak>([\s\S]*?)<\/speak>/gi;

/** Splits a voice reply. `spoken` joins all <speak> blocks (undefined when there are none). `chat` is the reply without them, trimmed. */
export function splitSpeak(text: string): { spoken: string | undefined; chat: string } {
  const blocks = [...text.matchAll(SPEAK_BLOCK)].map(match => match[1]!.trim()).filter(Boolean);
  return { spoken: blocks.length ? blocks.join(' ') : undefined, chat: text.replace(SPEAK_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim() };
}
