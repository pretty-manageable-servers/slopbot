// The project queries. The list carries the limits; one project carries its files, chats and the storage it uses. Every
// project query sits under ["projects"], so one invalidate refreshes the list and the open project.
import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const projectsKey = ["projects"] as const;
export const projectsQuery = queryOptions({ queryKey: projectsKey, queryFn: () => api.projects() });
export const projectQuery = (id: string) => queryOptions({ queryKey: [...projectsKey, id], queryFn: () => api.project(id) });
export const memoriesQuery = (id: string) => queryOptions({
  queryKey: [...projectsKey, id, "memories"],
  queryFn: async () => (await api.memories(id)).memories,
});
