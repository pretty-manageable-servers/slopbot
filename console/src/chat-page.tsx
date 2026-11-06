// A private chat page: the chat with its effort. A new chat (no id) is made on the first send, in the picked server.
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "./api";
import { Chat } from "./chat";
import { chatsQuery, useServer } from "./data";

export function ChatPage({ id }: { id?: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const server = useServer();
  const { data: chats } = useSuspenseQuery(chatsQuery);
  // The effort for a chat that does not exist yet. It is saved on the chat when the chat is made.
  const [draftEffort, setDraftEffort] = useState("medium");
  const current = chats.find((c) => c.id === id);
  const refresh = () => void client.invalidateQueries({ queryKey: chatsQuery.queryKey });

  const create = async () => {
    const { id: made } = await api.createChat(server.id);
    if (draftEffort !== "medium") await api.update(made, { effort: draftEffort }).catch(() => {});
    void navigate({ to: "/chat/$chatId", params: { chatId: made }, replace: true });
    refresh();
    return made;
  };
  const setEffort = (effort: string) => {
    if (!id) return setDraftEffort(effort);
    client.setQueryData(chatsQuery.queryKey, (list) => list?.map((c) => (c.id === id ? { ...c, effort: effort as typeof c.effort } : c)));
    api.update(id, { effort }).catch(refresh);
  };

  return <Chat key={id ?? "new"} id={id} title={current?.title ?? ""} effort={id ? current?.effort ?? "medium" : draftEffort} onEffort={setEffort} onCreate={create} onSent={refresh} />;
}
