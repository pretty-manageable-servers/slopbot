// The command palette's matching and sections, with no React: the fuzzy match of src/search/fuzzy.ts (words in any
// order, partial words, typos, no case or accents), the strict match of actions (as web/palette.js), the sections
// for a filter, and the recent picks. The palette (palette.tsx) draws what this returns.

export type Group = "chats" | "channels" | "servers" | "actions" | "messages";
export type Filter = "all" | Group;

/** The filter pills in order. Each key is also a row group. */
export const FILTERS: [Filter, string][] = [["all", "All"], ["chats", "Chats"], ["channels", "Channels"], ["servers", "Servers"], ["messages", "Messages"], ["actions", "Actions"]];
export const TITLES: Record<Group, string> = { chats: "Chats", channels: "Channels", servers: "Servers", actions: "Actions", messages: "Messages" };
/** The order of the sections when a query is typed. */
const GROUP_ORDER: Group[] = ["chats", "channels", "servers", "actions", "messages"];
export const RECENT_MAX = 6;
export const MESSAGE_HINT = "Type two or more letters to search messages.";
export const RECENT_KEY = "slopbot.palette.recent";

/** A row the palette can show. The key is stable across renders, so a recent pick can find its row again. */
export interface PaletteItem { key: string; group: Group; name: string; ts?: number }
export interface Section<T extends PaletteItem> { title: string; items: T[]; status?: string }

// ----- Fuzzy match: the same rules as src/search/fuzzy.ts. 0 means no match. -----

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
  const words = [...new Set(fuzzyWords(text).slice(0, 400))];
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

/**
 * Actions match strictly (palette.js): a word start or a substring ranks first, by position. Letters in order, with
 * gaps, count only for a query of 3+ characters, and only when the letters stay close. Lower is better; -1 is no match.
 */
export function strictScore(query: string, text: string): number {
  const q = query.trim().toLowerCase(), t = text.toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at >= 0) return at === 0 || !/[a-z0-9]/.test(t[at - 1]!) ? at : 50 + at;
  if (q.length < 3) return -1;
  let pos = -1, first = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, pos + 1);
    if (found < 0 || (pos >= 0 && found - pos - 1 > 2)) return -1;
    if (first < 0) first = found;
    pos = found;
  }
  const span = pos - first + 1;
  return span > q.length + 3 ? -1 : 100 + span - q.length;
}

/** Lower is better. Actions use the strict match; chats, channels and servers use the fuzzy match. -1 is no match. */
export function rankScore(item: PaletteItem, query: string): number {
  if (item.group === "actions") return strictScore(query, item.name);
  const found = fuzzyScore(query, item.name);
  return found > 0 ? 1 - found : -1;
}

// ----- Sections -----

const withItems = <T extends PaletteItem>(sections: Section<T>[]) => sections.filter(section => section.items.length || section.status);

/**
 * The sections for the typed query and the filter. With no text: under All, the recent rows and the actions; under a
 * filter, that filter's rows. With text: the matching rows of each group, best first, in the order of GROUP_ORDER.
 * Messages come from the message search (`messages`) and show from two letters.
 */
export function buildSections<T extends PaletteItem>(all: T[], query: string, filter: Filter, recent: T[], messages: { items: T[]; status?: string }): Section<T>[] {
  if (!query) {
    if (filter === "all") return withItems([{ title: "Recent", items: recent }, { title: TITLES.actions, items: all.filter(item => item.group === "actions") }]);
    if (filter === "messages") return [{ title: TITLES.messages, items: [], status: MESSAGE_HINT }];
    return withItems([{ title: TITLES[filter], items: all.filter(item => item.group === filter) }]);
  }
  const sections: Section<T>[] = [];
  for (const group of filter === "all" ? GROUP_ORDER : [filter]) {
    if (group === "messages") {
      if (query.length >= 2) sections.push({ title: TITLES.messages, items: messages.items, status: messages.status });
      else if (filter === "messages") sections.push({ title: TITLES.messages, items: [], status: MESSAGE_HINT });
      continue;
    }
    const items = all
      .filter(item => item.group === group)
      .map(item => ({ item, score: rankScore(item, query) }))
      .filter(entry => entry.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map(entry => entry.item);
    if (items.length) sections.push({ title: TITLES[group], items });
  }
  return sections;
}

/**
 * The Recent rows for an empty field: the picked rows first (newest pick first), then the newest chats and channels
 * that were not picked, at most RECENT_MAX in all. Picks whose row is gone (a deleted chat) are skipped.
 */
export function recentItems<T extends PaletteItem>(all: T[], picks: string[]): T[] {
  const byKey = new Map(all.map(item => [item.key, item] as const));
  const picked = picks.flatMap(key => byKey.get(key) ?? []);
  const shown = new Set(picked.map(item => item.key));
  const newest = all
    .filter(item => (item.group === "chats" || item.group === "channels") && item.ts !== undefined && !shown.has(item.key))
    .sort((a, b) => b.ts! - a.ts!);
  return [...picked, ...newest].slice(0, RECENT_MAX);
}

/** The picks after one more pick: the key goes first, without repeats, at most RECENT_MAX. */
export function pushRecent(picks: string[], key: string): string[] {
  return [key, ...picks.filter(pick => pick !== key)].slice(0, RECENT_MAX);
}

/** The stored picks. A bad value counts as no picks. */
export function parseRecent(text: string | null): string[] {
  try {
    const value: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** The words around the first word of the query in a message, about 240 characters, with "…" when it starts later. */
export function snippetOf(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = Math.max(0, flat.toLowerCase().indexOf((query.split(/\s+/)[0] ?? "").toLowerCase()));
  const start = Math.max(0, at - 60);
  return (start ? "…" : "") + flat.slice(start, start + 240);
}
