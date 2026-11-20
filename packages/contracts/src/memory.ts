import { z } from "zod";

/** One memory as the Memory page shows it. scope is "personal" or "project:<id>". */
export const MemoryItem = z.object({
  id: z.string(), content: z.string(), category: z.enum(["fact", "meme", "preference", "lesson", "note"]),
  tags: z.array(z.string()), scope: z.string(), /* "personal" | "project:<id>" */ updated: z.number().int(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

export const MemoryList = z.object({ items: z.array(MemoryItem), total: z.number().int().nonnegative() });
export type MemoryList = z.infer<typeof MemoryList>;
