/** Lines of program code that a full footer shows inline. */
export const SHOW_CODE_INLINE_LINES = 15;
/** Characters of program code that fit in one Discord message. Longer code is sent as program.js. */
export const SHOW_CODE_MESSAGE_CHARS = 1900;
/** Program code is kept this long, then deleted. */
export const PROGRAM_CODE_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/** True when the code fits inline in a full footer. */
export function codeFitsInline(code: string): boolean {
  return code.split("\n").length <= SHOW_CODE_INLINE_LINES && code.length <= SHOW_CODE_MESSAGE_CHARS;
}

/** A Markdown block. The fence is longer than any backtick run in the text. */
export function codeBlock(text: string, language = "js"): string {
  const longest = [...text.matchAll(/`+/g)].reduce((most, match) => Math.max(most, match[0].length), 2);
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

/** Splits code into parts that each fit one message as a code block. Splits at line ends when it can. */
export function codeParts(code: string, limit = SHOW_CODE_MESSAGE_CHARS): string[] {
  const parts: string[] = [];
  let part = "";
  for (const line of code.split("\n")) {
    for (let piece = line; ; piece = piece.slice(limit)) {
      const next = part ? `${part}\n${piece.slice(0, limit)}` : piece.slice(0, limit);
      if (next.length > limit && part) { parts.push(part); part = piece.slice(0, limit); } else part = next;
      if (piece.length <= limit) break;
      parts.push(part); part = "";
    }
  }
  if (part || !parts.length) parts.push(part);
  return parts;
}
