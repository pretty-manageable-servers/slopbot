import { z } from "zod";

/** Where a turn came from. A Discord DM is "discord-dm", not "web". A private chat is "web-incognito". */
export const Surface = z.enum(["discord", "discord-dm", "web", "web-incognito"]);
export type Surface = z.infer<typeof Surface>;

/** What a surface can show or do. A tool lists the capabilities it needs. */
export const Capability = z.enum(["discord_actions", "web_visuals", "live_tool_input", "channel_history", "memory", "files"]);
export type Capability = z.infer<typeof Capability>;

export const SURFACE_CAPABILITIES: Readonly<Record<Surface, readonly Capability[]>> = {
  discord: ["discord_actions", "channel_history", "memory", "files"],
  "discord-dm": ["channel_history", "memory", "files"],
  web: ["web_visuals", "live_tool_input", "memory", "files"],
  "web-incognito": ["web_visuals", "live_tool_input"],
};
