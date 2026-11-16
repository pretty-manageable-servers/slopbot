// /projects: your projects as cards, with New project. The bot's limit on projects comes with the list and is shown
// with the count. Project rules are in project-format.ts.
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChatHeader, SidebarToggle } from "agentic-ui-kit";
import { Alert, Button, Card, EmptyState, Modal, TextField } from "slop-ui-components";
import { useState } from "react";
import { ApiError, api } from "../api";
import type { ProjectLimits } from "../api-types";
import { BASE } from "../router";
import { notifyError } from "../ui/feedback";
import { ago } from "../ui/time";
import { projectsKey, projectsQuery } from "./queries";
import { DESCRIPTION_MAX, descriptionProblem, nameProblem, plural, projectErrorText, textLength } from "./project-format";

/** The user's projects, newest first as the bot sends them. */
export function ProjectsPage() {
  const { data: list } = useSuspenseQuery(projectsQuery);
  const [creating, setCreating] = useState(false);
  const { projects, limits } = list;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader
        leading={<SidebarToggle drawerOnly />}
        title="Projects"
        actions={<Button variant="secondary" size="sm" onPress={() => setCreating(true)}>New project</Button>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full px-4 pb-8" style={{ maxWidth: "var(--chat-content-width)" }}>
          {projects.length === 0 ? (
            <EmptyState
              headingLevel={2}
              title="No projects yet"
              description="Keep related chats, files and instructions together in a project."
              actions={<Button variant="secondary" size="sm" onPress={() => setCreating(true)}>New project</Button>}
            />
          ) : (
            <>
              <p className="m-0 mb-3 text-ui-sm text-muted">{projects.length} of {limits.maxProjects} projects</p>
              <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((project) => (
                  <li key={project.id}>
                    <Card href={`${BASE}/project/${project.id}`} aria-label={project.name} className="h-full">
                      <h2 className="m-0 truncate font-serif text-lg font-normal">{project.name}</h2>
                      {project.description && <p className="m-0 mt-1 line-clamp-2 text-ui text-muted">{project.description}</p>}
                      <p className="m-0 mt-3 text-ui-sm text-muted">{plural(project.fileCount, "file")} · Updated {ago(project.updated)}</p>
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
      <NewProject open={creating} limits={limits} onClose={() => setCreating(false)} />
    </div>
  );
}

/** The New project dialog. A name and an optional description. A full list of projects is shown in the dialog. */
function NewProject({ open, limits, onClose }: { open: boolean; limits: ProjectLimits; onClose: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [limitText, setLimitText] = useState<string | null>(null);
  const invalid = (name ? nameProblem(name) : null) ?? descriptionProblem(description);

  const close = () => {
    setName("");
    setDescription("");
    setLimitText(null);
    onClose();
  };
  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), description: description.trim() }),
    onSuccess: (project) => {
      void client.invalidateQueries({ queryKey: projectsKey });
      close();
      void navigate({ to: "/project/$projectId", params: { projectId: project.id } });
    },
    onError: (error) => {
      // The bot answers a full list with 409 and the code. Other errors are a notice.
      const text = error instanceof ApiError ? projectErrorText(error.message, limits) : null;
      if (text) setLimitText(text);
      else notifyError(error);
    },
  });

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) close(); }} title="New project" description="Chats, files, instructions and memory stay with the project." size="md"
      footer={(
        <>
          <Button variant="ghost" onPress={close}>Cancel</Button>
          <Button variant="primary" isDisabled={!name.trim() || !!invalid || create.isPending} onPress={() => create.mutate()}>Create project</Button>
        </>
      )}>
      <div className="flex flex-col gap-3 text-ui">
        {limitText && <Alert tone="danger">{limitText}</Alert>}
        <TextField label="Name" value={name} onChange={setName} autoFocus errorMessage={(name && nameProblem(name)) || undefined} />
        <TextField multiline rows={3} label="Description (optional)" value={description} onChange={setDescription}
          description={`${textLength(description)} / ${DESCRIPTION_MAX}`} errorMessage={descriptionProblem(description) ?? undefined} />
      </div>
    </Modal>
  );
}
