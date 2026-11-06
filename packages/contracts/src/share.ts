/**
 * The public share page's data: a frozen copy of a chat, written into the page as JSON (sharePageData in
 * src/shares.ts) and read by the share page (console/src/share-page.tsx). Images are served from `src`, files
 * have names and sizes only.
 */
export interface ShareData {
  id: string;
  messages: ShareMessageData[];
}

export interface ShareMessageData {
  author: string; bot: boolean; at: number | null; text: string;
  tools: { name: string; status: string; input?: unknown }[];
  thinking: string;
  images: { src: string; name: string }[];
  files: { name: string; size: number }[];
  /** Attachments that are not in this copy (not images or files). */
  other: number;
}
