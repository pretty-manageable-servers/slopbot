// The Bud queries. One query holds the settings, sprouts, waiting approvals and the unread count; every Bud query sits
// under ["assistant"], so one invalidate refreshes the page and the sidebar count. The activity feed pages on its own.
import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const assistantKey = ["assistant"] as const;
export const assistantQuery = queryOptions({ queryKey: assistantKey, queryFn: () => api.assistant() });
export const activityKey = [...assistantKey, "activity"] as const;
export const connectorsKey = [...assistantKey, "connectors"] as const;
export const connectorsQuery = queryOptions({ queryKey: connectorsKey, queryFn: () => api.connectors().then((body) => body.connectors) });

/** A sprout's chat is the web chat of its channel, `web:assistant-task:<id>`: the chat id is the channel without `web:`. */
export const sproutChatId = (taskId: string) => `assistant-task:${taskId}`;
