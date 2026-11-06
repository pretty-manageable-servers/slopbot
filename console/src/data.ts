// Shared data: the query client, the queries more than one part of the console reads, and the server picked in
// the drawer. A part's own queries live next to it (for example settings/sections/bot-usage.tsx). Query keys
// start with the route's area: ["session"], ["chats"], ["settings", server], ["admin", ...], ["conversations", server, ...].
import { QueryClient, queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api, get, post, qs } from "./api";
import type { AdminMe, ServerSnapshot, ServerSummary, SettingArgs, SettingName, SettingsResponse, ToolResult } from "./api-types";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: (count, error) => count < 2 && !(error as { status?: number }).status } },
});

export const sessionQuery = queryOptions({ queryKey: ["session"], queryFn: () => api.session(), staleTime: Infinity });
export const chatsQuery = queryOptions({ queryKey: ["chats"], queryFn: () => api.chats() });
/** The server settings snapshot. It also gives the server's channels and the user's profile. */
export const settingsQuery = (server: string) => queryOptions({
  queryKey: ["settings", server],
  queryFn: () => get<SettingsResponse>(`/api/settings${qs({ server })}`).then((r) => r.data as ServerSnapshot),
});
/** The user's team role, or null when the user is not on the Slopbot team. Admin sections show only with a role. */
export const adminMeQuery = queryOptions({
  queryKey: ["admin", "me"],
  queryFn: () => get<AdminMe>("/api/admin/me").catch(() => null),
  staleTime: Infinity,
});

// ----- The picked server: new chats, server settings and the Servers view use it. Kept per browser. -----
const SERVER_KEY = "slopbot.server";
const listeners = new Set<() => void>();
const readServer = () => { try { return localStorage.getItem(SERVER_KEY) ?? ""; } catch { return ""; } };
let picked = readServer();

export function pickServer(id: string) {
  picked = id;
  try { localStorage.setItem(SERVER_KEY, id); } catch { /* private mode: kept until reload */ }
  for (const listener of listeners) listener();
}

/** The picked server, or the first shared server when none is picked or it is no longer shared. */
export function useServer(): ServerSummary {
  const id = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => picked);
  const { data: session } = useSuspenseQuery(sessionQuery);
  return session.servers.find((s) => s.id === id) ?? session.servers[0]!;
}

/** One setting to save: its name, its args, and the channel for channel settings. */
export type SaveSetting = { [N in SettingName]: { name: N; args: SettingArgs[N]; channel?: string } }[SettingName];

/**
 * Saves one server setting through POST /api/settings and reloads the snapshot. The bot's answer text is the
 * result (for example "Monitoring is on."). Settings that name a channel get it in `channel`; the others go to
 * the first channel, as the old console did.
 */
export function useSaveSetting(server: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, args, channel }: SaveSetting) => {
      const snapshot = client.getQueryData<ServerSnapshot>(["settings", server]) ?? await client.fetchQuery(settingsQuery(server));
      const target = channel ?? snapshot.channels[0]?.id;
      if (!target) throw new Error("You and Slopbot need access to a server text channel.");
      return post<ToolResult>("/api/settings", { server, channel: target, name, args });
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["settings", server] }),
  });
}
