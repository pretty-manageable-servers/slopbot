// Instructions: your standing instructions for Slopbot (tone, format, what to know about you). They are used in your
// web chats and Discord DMs, not in server channels. The bot checks each save and answers a rejected one with 422 and
// the reason. The rules that can be tested are in instructions-form.ts.
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Markdown } from "agentic-ui-kit";
import { Button, SegmentedControl, SettingsGroup, SettingsRow, TextField } from "slop-ui-components";
import { useState } from "react";
import { get, post } from "../../api";
import type { UserInstructionsView } from "../../api-types";
import { notify, notifyError } from "../../ui/feedback";
import { canSave, instructionsLength, rejectMessage } from "./instructions-form";

const instructionsKey = ["settings", "instructions"] as const;
const instructionsQuery = queryOptions({ queryKey: instructionsKey, queryFn: () => get<UserInstructionsView>("/api/settings/instructions") });

type EditorView = "write" | "preview";
const EDITOR_VIEWS: { id: EditorView; label: string }[] = [{ id: "write", label: "Write" }, { id: "preview", label: "Preview" }];

export default function Instructions() {
  const client = useQueryClient();
  const { data: current } = useSuspenseQuery(instructionsQuery);
  const [draft, setDraft] = useState(current.text ?? "");
  const [editor, setEditor] = useState<EditorView>("write");
  const [rejected, setRejected] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (text: string) => post<UserInstructionsView>("/api/settings/instructions", { text }),
    onSuccess: (saved, text) => {
      client.setQueryData(instructionsKey, saved);
      setDraft(saved.text ?? "");
      notify(text === "" ? "Instructions cleared." : "Instructions saved.");
    },
    onError: (error) => {
      const message = rejectMessage(error);
      // A rejected text stays in the editor so it can be changed and sent again.
      if (message === null) notifyError(error);
      else setRejected(message);
    },
  });
  const send = (text: string) => {
    setRejected(null);
    save.mutate(text);
  };
  const length = instructionsLength(draft);

  return (
    <SettingsGroup title="Instructions"
      description="Tell Slopbot how to answer you: tone, format, what to know about you. Used in your web chats and Discord DMs, not in server channels. Markdown works."
      actions={
        <>
          {current.text && <Button variant="outline" size="sm" isDisabled={save.isPending} onPress={() => send("")}>Clear</Button>}
          <Button variant="secondary" size="sm" isDisabled={!canSave(draft, current.text, current.max, save.isPending)} onPress={() => send(draft)}>Save</Button>
        </>
      }>
      <SettingsRow label="Instructions" layout="stacked" description="Checked for safety when you save.">
        <div className="flex flex-col gap-1">
          <SegmentedControl aria-label="Editor view" options={EDITOR_VIEWS} value={editor} onChange={(next) => setEditor(next)} className="self-start" />
          {editor === "preview"
            ? <div className="min-h-60 rounded-sm border border-border bg-surface px-2.5 py-1.5 text-ui">
                <Markdown>{draft.trim() ? draft : "Nothing to preview."}</Markdown>
              </div>
            : <TextField multiline aria-label="Instructions" value={draft} onChange={setDraft} maxLength={current.max} rows={12}
                placeholder="For example: Answer in British English. Use short paragraphs and code blocks for commands."
                description={`${length} / ${current.max}`} errorMessage={rejected ?? undefined} />}
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}
