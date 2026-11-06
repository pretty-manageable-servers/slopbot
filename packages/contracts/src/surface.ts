import { z } from "zod";

/** Where a turn came from. A Discord DM is "discord-dm", not "web". */
export const Surface = z.enum(["discord", "discord-dm", "web"]);
export type Surface = z.infer<typeof Surface>;

/** What a surface can show or do. A tool lists the capabilities it needs. */
export const Capability = z.enum(["discord_actions", "web_visuals", "live_tool_input"]);
export type Capability = z.infer<typeof Capability>;

export const SURFACE_CAPABILITIES: Readonly<Record<Surface, readonly Capability[]>> = {
  discord: ["discord_actions"],
  "discord-dm": [],
  web: ["web_visuals", "live_tool_input"],
};
