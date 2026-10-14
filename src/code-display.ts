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
