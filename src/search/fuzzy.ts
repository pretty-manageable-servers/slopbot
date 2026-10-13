import type { Message } from "../domain.js";

/**
 * Fuzzy matching for the web console. A query matches a text when every query word matches some word of the text.
 * Words may come in any order, may be partial ("deplo" matches "deployment") and may have typos ("hotfx" matches "hotfix").
 * Case and accents do not count. A match scores from 0 to 1. Zero means no match.
 */

/** Words of the query, in order. A message is searched in its newest messages (see FUZZY_SCAN). */
export interface FuzzyQuery {
  server: string;
  channel: string;
  query: string;
  limit: number;
}

export interface FuzzyHit {
  message: Message;
  score: number;
}

/** Newest messages of one channel that are always scored, before the LIKE candidates are added. */
export const FUZZY_SCAN = 500;
/** Most query words used to find candidates in SQL. Extra words still count in the score. */
export const FUZZY_TERMS = 6;
const MAX_WORDS = 400;

/** Lower case, no accents. Used for both queries and texts. */
export function foldText(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** The words of a text, folded. Punctuation and spaces split words. */
export function fuzzyWords(text: string): string[] {
  return foldText(text).split(/[^\p{L}\p{N}]+/u).filter(word => word !== "");
}

/** How many typos a query word may have. Short words must match exactly. */
function typoLimit(length: number): number {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

/** Optimal string alignment distance. Returns limit + 1 when the distance is above the limit. */
function distance(a: string, b: string, limit: number): number {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const row = [i];
    let low = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2]! + 1);
      row.push(value);
      low = Math.min(low, value);
    }
    if (low > limit) return limit + 1;
    before = previous;
    previous = row;
  }
  return previous[m]! > limit ? limit + 1 : previous[m]!;
}

/** How well one query word matches one text word, from 0 to 1. */
function wordScore(query: string, word: string): number {
  if (word === query) return 1;
  if (query.length >= 2 && word.startsWith(query)) return 0.9;
  if (query.length >= 4 && word.includes(query)) return 0.8;
  const limit = typoLimit(query.length);
  if (!limit) return 0;
  // A typo can also be in a partial word, so the word's prefixes of similar length count too.
  let best = distance(query, word, limit);
  for (const length of [query.length - 1, query.length, query.length + 1]) {
    if (length > 0 && length < word.length) best = Math.min(best, distance(query, word.slice(0, length), limit));
  }
  return best > limit ? 0 : Math.max(0.1, 0.75 - 0.15 * best);
}

/** Score of one query against one text, from 0 to 1. Zero means no match. */
export function fuzzyScore(query: string, text: string): number {
  const phrase = foldText(query).trim();
  if (!phrase) return 0;
  const body = foldText(text);
  if (body.includes(phrase)) return 1;
  const terms = [...new Set(fuzzyWords(query))];
  if (!terms.length) return 0;
  const words = [...new Set(fuzzyWords(text).slice(0, MAX_WORDS))];
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const word of words) {
      const score = wordScore(term, word);
      if (score > best) best = score;
      if (best === 1) break;
    }
    if (best === 0) return 0;
    total += best;
  }
  // The words in the same order, next to each other, count a little more.
  const ordered = fuzzyWords(text).join(" ").includes(terms.join(" "));
  return Math.min(1, total / terms.length + (terms.length > 1 && ordered ? 0.1 : 0));
}

/** Newest first among equal scores. */
function newer(a: Message, b: Message): number {
  return (b.timestamp ?? 0) - (a.timestamp ?? 0) || a.id.localeCompare(b.id);
}

/** The best matches of a query, best first. Ties go to the newest message. */
export function rankFuzzy(query: string, messages: readonly Message[], limit: number): FuzzyHit[] {
  return messages
    .map(message => ({ message, score: fuzzyScore(query, message.text ?? "") }))
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || newer(a.message, b.message))
    .slice(0, limit);
}

/** The SQL LIKE pattern of a query word, for finding candidates. Only letters and digits reach it. */
export function likePattern(word: string): string {
  return "%" + word.replace(/[\\%_]/g, "\\$&") + "%";
}
