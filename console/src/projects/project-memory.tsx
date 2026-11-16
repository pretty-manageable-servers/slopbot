// A project's shared memory: what Slopbot keeps across the project's chats. Each memory can be edited in place or deleted.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, TextField, confirm } from "slop-ui-components";
import { useState } from "react";
import { api } from "../api";
import type { ProjectMemoryView } from "../api-types";
import { notifyError } from "../ui/feedback";
import { SectionNote } from "../ui/layout";
import { ago } from "../ui/time";
import { memoriesQuery } from "./queries";

export function ProjectMemory({ projectId }: { projectId: string }) {
  const memories = useQuery(memoriesQuery(projectId));
  if (memories.error) return <SectionNote>Memory is not available right now.</SectionNote>;
  if (!memories.data) return <SectionNote>Loading…</SectionNote>;
  if (memories.data.length === 0) return <SectionNote>No memory yet. What Slopbot learns in this project's chats is kept here.</SectionNote>;
  return (
    <ul aria-label="Memory" className="m-0 flex list-none flex-col divide-y divide-divider rounded-lg border border-border p-0">
      {memories.data.map((memory) => <MemoryRow key={memory.id} projectId={projectId} memory={memory} />)}
    </ul>
  );
}

function MemoryRow({ projectId, memory }: { projectId: string; memory: ProjectMemoryView }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const refresh = () => void client.invalidateQueries({ queryKey: memoriesQuery(projectId).queryKey });

  const save = useMutation({
    mutationFn: () => api.updateMemory(projectId, memory.id, draft.trim()),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
    onError: notifyError,
  });
  const remove = useMutation({
    mutationFn: () => api.removeMemory(projectId, memory.id),
    onSuccess: refresh,
    onError: notifyError,
  });
  const askRemove = async () => {
    if (await confirm({ title: "Delete this memory?", description: "This cannot be undone.", confirmLabel: "Delete", destructive: true })) remove.mutate();
  };
  const cancel = () => {
    setDraft(memory.content);
    setEditing(false);
  };
  const changed = draft.trim() !== memory.content;

  return (
    <li className="flex flex-col gap-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <Badge>{memory.category}</Badge>
        <span className="text-ui-sm text-muted">Updated {ago(memory.updatedAt)}</span>
      </div>
      {editing ? (
        <>
          <TextField multiline rows={3} aria-label="Memory text" value={draft} onChange={setDraft} errorMessage={draft.trim() ? undefined : "Memory cannot be empty."} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onPress={cancel}>Cancel</Button>
            <Button variant="secondary" size="sm" isDisabled={!changed || !draft.trim() || save.isPending} onPress={() => save.mutate()}>Save</Button>
          </div>
        </>
      ) : (
        <>
          <p className="m-0 whitespace-pre-wrap text-ui">{memory.content}</p>
          <div className="flex justify-end gap-1">
            <Button variant="ghost" size="sm" isDisabled={remove.isPending} onPress={() => setEditing(true)}>Edit</Button>
            <Button variant="ghost" size="sm" isDisabled={remove.isPending} onPress={askRemove}>Delete</Button>
          </div>
        </>
      )}
    </li>
  );
}
