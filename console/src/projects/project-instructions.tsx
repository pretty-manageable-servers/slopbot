// A project's instructions: how Slopbot answers in the project's chats. The editor is the Settings Instructions form (Write
// and Preview, the counter, the bot's reason for a rejected save under the text). The bot checks each save.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Markdown } from "agentic-ui-kit";
import { Button, SegmentedControl, SettingsGroup, SettingsRow, TextField } from "slop-ui-components";
import { useState } from "react";
import { api } from "../api";
import type { Project } from "../api-types";
import { canSave } from "../settings/sections/instructions-form";
import { notify, notifyError } from "../ui/feedback";
import { INSTRUCTIONS_MAX, textLength } from "./project-format";
import { projectsKey } from "./queries";

type EditorView = "write" | "preview";
const EDITOR_VIEWS: { id: EditorView; label: string }[] = [{ id: "write", label: "Write" }, { id: "preview", label: "Preview" }];

export function ProjectInstructions({ project }: { project: Project }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(project.instructions);
  const [editor, setEditor] = useState<EditorView>("write");
  const [rejected, setRejected] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (text: string) => api.saveInstructions(project.id, text),
    onSuccess: (result, text) => {
      // A rejected text stays in the editor, with the reason, so it can be changed and sent again.
      if (!result.ok) {
        setRejected(result.message);
        return;
      }
      setRejected(null);
      setDraft(result.project.instructions);
      notify(text === "" ? "Instructions cleared." : "Instructions saved.");
      void client.invalidateQueries({ queryKey: projectsKey });
    },
    onError: notifyError,
  });
  const send = (text: string) => {
    setRejected(null);
    save.mutate(text);
  };

  return (
    <SettingsGroup title="Instructions"
      description="How Slopbot answers in this project's chats. Markdown works."
      actions={
        <>
          {project.instructions && <Button variant="outline" size="sm" isDisabled={save.isPending} onPress={() => send("")}>Clear</Button>}
          <Button variant="secondary" size="sm" isDisabled={!canSave(draft, project.instructions, INSTRUCTIONS_MAX, save.isPending)} onPress={() => send(draft)}>Save</Button>
        </>
      }>
      <SettingsRow label="Instructions" layout="stacked" description="Checked for safety when you save.">
        <div className="flex flex-col gap-1">
          <SegmentedControl aria-label="Editor view" options={EDITOR_VIEWS} value={editor} onChange={(next) => setEditor(next)} className="self-start" />
          {editor === "preview"
            ? <div className="min-h-60 rounded-sm border border-border bg-surface px-2.5 py-1.5 text-ui">
                <Markdown>{draft.trim() ? draft : "Nothing to preview."}</Markdown>
              </div>
            : <TextField multiline aria-label="Instructions" value={draft} onChange={setDraft} maxLength={INSTRUCTIONS_MAX} rows={12}
                placeholder="For example: Answer in British English. Use short paragraphs and code blocks for commands."
                description={`${textLength(draft)} / ${INSTRUCTIONS_MAX}`} errorMessage={rejected ?? undefined} />}
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}
