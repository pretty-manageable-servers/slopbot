// /project/$projectId: one project. Its name and description, Instructions, then Files, Memory and Chats in tabs, and
// Delete at the end. Deleting a project deletes its files, memories and chats; the confirm says how many chats.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChatHeader, SidebarToggle } from "agentic-ui-kit";
import { Button, DataTable, Tab, TabList, TabPanel, Tabs, TextField, SettingsGroup, SettingsRow, confirm } from "slop-ui-components";
import { useState } from "react";
import { api } from "../api";
import type { ChatSummary, Project } from "../api-types";
import { chatsQuery } from "../data";
import { BASE } from "../router";
import { notify, notifyError } from "../ui/feedback";
import { PageLoading, PageNote } from "../ui/page-state";
import { ago } from "../ui/time";
import { ProjectFiles } from "./project-files";
import { ProjectInstructions } from "./project-instructions";
import { ProjectMemory } from "./project-memory";
import { DESCRIPTION_MAX, deleteProjectText, descriptionProblem, nameProblem, textLength } from "./project-format";
import { projectQuery, projectsKey, projectsQuery } from "./queries";

type ProjectTab = "files" | "memory" | "chats";

export function ProjectPage({ id }: { id: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const detail = useQuery(projectQuery(id));
  const list = useQuery(projectsQuery);
  const [tab, setTab] = useState<ProjectTab>("files");

  const remove = useMutation({
    mutationFn: () => api.deleteProject(id),
    onSuccess: () => {
      notify("Project deleted.");
      void client.invalidateQueries({ queryKey: projectsKey });
      // Its chats are gone from the sidebar too.
      void client.invalidateQueries({ queryKey: chatsQuery.queryKey });
      void navigate({ to: "/projects" });
    },
    onError: notifyError,
  });

  if (detail.error) return <PageNote>This project is not available.</PageNote>;
  if (!detail.data || !list.data) return <PageLoading />;
  const { project, files, chats, usedBytes } = detail.data;
  const askDelete = async () => {
    if (await confirm({ title: "Delete this project?", description: deleteProjectText(chats.length), confirmLabel: "Delete project", destructive: true })) remove.mutate();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader leading={<SidebarToggle drawerOnly />} title={project.name} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full flex-col gap-8 px-4 pb-8" style={{ maxWidth: "var(--chat-content-width)" }}>
          <ProjectDetails project={project} />
          <ProjectInstructions project={project} />
          <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(String(key) as ProjectTab)}>
            <TabList aria-label="Project sections">
              <Tab id="files">Files</Tab>
              <Tab id="memory">Memory</Tab>
              <Tab id="chats">Chats</Tab>
            </TabList>
            <TabPanel id="files" className="pt-4">
              <ProjectFiles projectId={id} files={files} usedBytes={usedBytes} limits={list.data.limits} />
            </TabPanel>
            <TabPanel id="memory" className="pt-4">
              <ProjectMemory projectId={id} />
            </TabPanel>
            <TabPanel id="chats" className="pt-4">
              <ProjectChats projectId={id} chats={chats} />
            </TabPanel>
          </Tabs>
          <SettingsGroup title="Delete project" description={deleteProjectText(chats.length)}>
            <div><Button variant="danger" size="sm" isDisabled={remove.isPending} onPress={askDelete}>Delete project</Button></div>
          </SettingsGroup>
        </div>
      </div>
    </div>
  );
}

/** The name and description, saved together. Save is off until something changes and both fit their limits. */
function ProjectDetails({ project }: { project: Project }) {
  const client = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const invalid = nameProblem(name) ?? descriptionProblem(description);
  const changed = name.trim() !== project.name || description.trim() !== project.description;

  const save = useMutation({
    mutationFn: () => api.updateProject(project.id, { name: name.trim(), description: description.trim() }),
    onSuccess: () => {
      notify("Project saved.");
      void client.invalidateQueries({ queryKey: projectsKey });
    },
    onError: notifyError,
  });

  return (
    <SettingsGroup title="Details"
      actions={<Button variant="secondary" size="sm" isDisabled={!changed || !!invalid || save.isPending} onPress={() => save.mutate()}>Save</Button>}>
      <SettingsRow label="Name" layout="stacked">
        <TextField aria-label="Name" value={name} onChange={setName} errorMessage={name ? nameProblem(name) ?? undefined : undefined} />
      </SettingsRow>
      <SettingsRow label="Description" layout="stacked">
        <TextField multiline rows={3} aria-label="Description" value={description} onChange={setDescription}
          description={`${textLength(description)} / ${DESCRIPTION_MAX}`} errorMessage={descriptionProblem(description) ?? undefined} />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** The project's chats, newest first, and New chat, which starts a chat in this project. */
function ProjectChats({ projectId, chats }: { projectId: string; chats: ChatSummary[] }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onPress={() => void navigate({ to: "/", search: { project: projectId } })}>New chat</Button>
      </div>
      <DataTable
        aria-label="Chats"
        rows={chats}
        rowKey={(chat) => chat.id}
        rowHref={(chat) => `${BASE}/chat/${chat.id}`}
        emptyState="No chats in this project yet."
        columns={[
          { id: "title", header: "Title", isRowHeader: true, cell: (chat) => chat.title || "New chat" },
          { id: "updated", header: "Updated", className: "w-36", cell: (chat) => ago(chat.updated) },
        ]}
      />
    </div>
  );
}
