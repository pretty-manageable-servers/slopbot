// The Settings sections in nav order. Each section is one file in sections/ with a default export and no props:
// it reads the picked server with useServer() and its own data with TanStack Query. Keywords feed the search box,
// so list the row labels of each section there.
import { lazy, type ComponentType, type ReactNode } from "react";
import { icons } from "../ui/icons";

export type SectionGroup = "you" | "server" | "admin";
export interface SectionInfo {
  id: string;
  label: string;
  icon: ReactNode;
  /** you: personal. server: the picked server (needs Manage Server to change). admin: Slopbot team only. */
  group: SectionGroup;
  keywords: string[];
  component: ComponentType;
}

const section = (id: string, label: string, icon: ReactNode, group: SectionGroup, keywords: string[], load: () => Promise<{ default: ComponentType }>): SectionInfo =>
  ({ id, label, icon, group, keywords, component: lazy(load) });

export const SECTIONS: SectionInfo[] = [
  section("account", "Account", icons.account, "you", ["profile", "name", "avatar", "profile fields", "allow edits", "non-zdr", "data retention", "log out"], () => import("./sections/account")),
  section("instructions", "Instructions", icons.account, "you", ["instructions", "custom instructions", "preferences", "personalization", "markdown", "about me", "tone"], () => import("./sections/instructions")),
  section("appearance", "Appearance", icons.appearance, "you", ["theme", "dark", "light", "text size", "font", "content width"], () => import("./sections/appearance")),
  section("usage", "Usage", icons.usage, "you", ["limits", "plan", "5 hour", "week", "reset", "banked"], () => import("./sections/usage")),
  section("server", "Server", icons.server, "server", ["monitoring", "join the conversation", "calibration", "participation", "context", "cooldown", "tool display", "default effort", "timing", "voice", "web transcripts"], () => import("./sections/server")),
  section("channels", "Channels & history", icons.channels, "server", ["monitored channels", "history", "saved messages", "import", "pause", "days"], () => import("./sections/channels")),
  section("mcp", "MCP connections", icons.mcp, "server", ["connector", "endpoint", "token", "tools", "transport"], () => import("./sections/mcp")),
  section("shares", "Shared links", icons.shares, "server", ["share", "links", "revoke"], () => import("./sections/shares")),
  section("limits", "Usage & limits", icons.limits, "admin", ["cost", "limits", "grace", "prices", "models", "bot replies", "schedule limits", "totals"], () => import("./sections/limits")),
  section("bot", "Bot", icons.bot, "admin", ["system prompt", "web keys", "tavily", "firecrawl", "llm", "fallback", "breaker", "webhooks", "non-zdr", "transcripts"], () => import("./sections/bot")),
  section("users", "Users", icons.users, "admin", ["user", "override", "grant", "reset", "usage"], () => import("./sections/users")),
  section("servers", "Servers", icons.servers, "admin", ["server list", "channels", "transcripts", "non-zdr"], () => import("./sections/servers")),
];

export const DEFAULT_SECTION = "appearance";
export const sectionById = (id: string | undefined) => SECTIONS.find((s) => s.id === id);
