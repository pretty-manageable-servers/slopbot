// A project's files: upload by button or by drop, each file checked against the bot's limits before it is sent, then the
// list with size, a download link and delete. The usage line is what the bot counts against the limits.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, DataTable, FileButton, FileDropZone, SettingsGroup, confirm } from "slop-ui-components";
import { useState } from "react";
import { ApiError, api } from "../api";
import type { ProjectFile, ProjectLimits } from "../api-types";
import { notify, notifyError } from "../ui/feedback";
import { ago } from "../ui/time";
import { fileProblem, projectErrorText, sizeText, usageText } from "./project-format";
import { projectsKey } from "./queries";

interface ProjectFilesProps {
  projectId: string;
  files: ProjectFile[];
  usedBytes: number;
  limits: ProjectLimits;
}

export function ProjectFiles({ projectId, files, usedBytes, limits }: ProjectFilesProps) {
  const client = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const refresh = () => void client.invalidateQueries({ queryKey: projectsKey });

  // The picked files go one by one. Each is checked against what the project holds now, plus the files before it.
  const add = async (picked: File[]) => {
    let usage = { files: files.length, bytes: usedBytes };
    setUploading(true);
    for (const file of picked) {
      const code = fileProblem(file, usage, limits);
      if (code) {
        notify(`${file.name}: ${projectErrorText(code, limits)}`, "error");
        continue;
      }
      try {
        await api.uploadProjectFile(projectId, file);
        usage = { files: usage.files + 1, bytes: usage.bytes + file.size };
        refresh();
      } catch (error) {
        const text = error instanceof ApiError ? projectErrorText(error.message, limits) : null;
        if (text) notify(`${file.name}: ${text}`, "error");
        else notifyError(error);
      }
    }
    setUploading(false);
  };

  const remove = useMutation({
    mutationFn: (fileId: string) => api.removeProjectFile(projectId, fileId),
    onSuccess: refresh,
    onError: notifyError,
  });
  const askRemove = async (file: ProjectFile) => {
    if (await confirm({ title: "Delete this file?", description: `${file.name} is removed from the project. This cannot be undone.`, confirmLabel: "Delete", destructive: true })) remove.mutate(file.id);
  };

  return (
    <SettingsGroup title="Files" description={usageText(usedBytes, files.length, limits)}
      actions={
        <FileButton size="sm" variant="secondary" isDisabled={uploading} onFiles={(picked) => void add(picked)}>Upload files</FileButton>
      }>
      <FileDropZone
        label="Drop files here or {browse}"
        description={`Up to ${sizeText(limits.maxFileBytes)} each.`}
        isDisabled={uploading}
        onFiles={(picked) => void add(picked)}
      />
      <DataTable
        aria-label="Files"
        rows={files}
        rowKey={(file) => file.id}
        emptyState="No files yet."
        columns={[
          { id: "name", header: "Name", isRowHeader: true, cell: (file) => <a href={api.projectFileUrl(projectId, file.id)} className="underline underline-offset-2">{file.name}</a> },
          { id: "size", header: "Size", numeric: true, className: "w-28", cell: (file) => sizeText(file.size) },
          { id: "added", header: "Added", className: "w-36", cell: (file) => ago(file.created) },
          { id: "actions", header: <span className="sr-only">Actions</span>, align: "end", className: "w-24", cell: (file) => <Button size="sm" variant="ghost" isDisabled={remove.isPending} onPress={() => askRemove(file)}>Delete</Button> },
        ]}
      />
    </SettingsGroup>
  );
}
