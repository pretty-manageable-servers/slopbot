// Pure helpers for the Servers section: the list's page size and the pager label.

/** Servers per page in the list. The API takes 1 to 50. */
export const SERVER_PAGE = 20;

/** The rows on a page as "1–20 of 45"; "0 of 0" when nothing matches. */
export function pageLabel(offset: number, shown: number, total: number): string {
  if (!total || !shown) return `0 of ${total}`;
  return `${offset + 1}–${offset + shown} of ${total}`;
}
