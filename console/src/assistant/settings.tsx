// Settings > Bud: whether Bud is on, its daily brief and updates (timezone, DMs, quiet hours), and its connectors.
// Registered in settings/sections.tsx as the "assistant" section.
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Button, confirm, DataTable, SettingsGroup, Switch, TextField } from "slop-ui-components";
import { useState } from "react";
import { api } from "../api";
import type { AssistantSettings } from "../api-types";
import { notify, notifyError } from "../ui/feedback";
import { assistantKey, assistantQuery, connectorsKey, connectorsQuery } from "./queries";

type Change = Partial<Omit<AssistantSettings, "user" | "updated">>;

export default function BudSettings() {
  const client = useQueryClient();
  const { data } = useSuspenseQuery(assistantQuery);
  const save = useMutation({
    mutationFn: (change: Change) => api.updateAssistantSettings(change),
    onSuccess: () => {
      notify("Saved.");
      void client.invalidateQueries({ queryKey: assistantKey });
    },
    onError: notifyError,
  });
  const { settings } = data;
  return (
    <>
      <SettingsGroup title="Bud" description="An always-on assistant that works on goals for you in the background.">
        <Switch toggleSide="end" isSelected={settings.enabled} isDisabled={save.isPending} onChange={(enabled) => save.mutate({ enabled })}>Turn on Bud</Switch>
      </SettingsGroup>
      <UpdatesGroup key={settings.updated} settings={settings} saving={save.isPending} onSave={(change) => save.mutate(change)} />
      <ConnectorsGroup />
    </>
  );
}

/** The brief and the updates. The form starts from the saved settings; a save or a change elsewhere starts it over. */
function UpdatesGroup({ settings, saving, onSave }: { settings: AssistantSettings; saving: boolean; onSave: (change: Change) => void }) {
  const [draft, setDraft] = useState(settings);
  const patch = (next: Partial<AssistantSettings>) => setDraft((current) => ({ ...current, ...next }));
  return (
    <SettingsGroup
      title="Updates"
      description="The daily brief, and where Bud sends its updates."
      actions={<Button variant="secondary" size="sm" isDisabled={saving} onPress={() => onSave({
        briefCron: draft.briefCron?.trim() || null,
        timezone: draft.timezone.trim(),
        dmUpdates: draft.dmUpdates,
        quietStart: draft.quietStart || null,
        quietEnd: draft.quietEnd || null,
      })}>Save</Button>}
    >
      <TextField label="Daily brief (cron)" value={draft.briefCron ?? ""} onChange={(briefCron) => patch({ briefCron })} placeholder="0 8 * * *" description="Empty for no daily brief." />
      <TextField label="Timezone" value={draft.timezone} onChange={(timezone) => patch({ timezone })} placeholder="Europe/Berlin" />
      <Switch toggleSide="end" isSelected={draft.dmUpdates} onChange={(dmUpdates) => patch({ dmUpdates })}>Send updates by DM</Switch>
      <TextField label="Quiet hours start" type="time" value={draft.quietStart ?? ""} onChange={(quietStart) => patch({ quietStart })} />
      <TextField label="Quiet hours end" type="time" value={draft.quietEnd ?? ""} onChange={(quietEnd) => patch({ quietEnd })} description="Bud sends no updates between these times." />
    </SettingsGroup>
  );
}

/** The connectors Bud can call: remote MCP servers by name and URL. The token is only sent, never shown again. */
function ConnectorsGroup() {
  const client = useQueryClient();
  const { data: connectors } = useSuspenseQuery(connectorsQuery);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const add = useMutation({
    mutationFn: () => api.saveConnector({ name: name.trim(), url: url.trim(), ...(token && { token }) }),
    onSuccess: ({ connectors: next }) => {
      client.setQueryData(connectorsKey, next);
      setName("");
      setUrl("");
      setToken("");
      notify("Connector saved.");
    },
    onError: notifyError,
  });
  const remove = useMutation({
    mutationFn: (connector: string) => api.removeConnector(connector),
    onSuccess: ({ connectors: next }) => client.setQueryData(connectorsKey, next),
    onError: notifyError,
  });
  const removeAfterConfirm = async (connector: string) => {
    if (await confirm({ title: `Remove ${connector}?`, confirmLabel: "Remove", destructive: true })) remove.mutate(connector);
  };
  return (
    <SettingsGroup title="Connectors" description="Remote MCP servers Bud can call. Each tool still follows the rules of its sprout.">
      <DataTable
        aria-label="Connectors"
        rows={connectors}
        rowKey={(connector) => connector.name}
        emptyState="No connectors yet."
        columns={[
          { id: "name", header: "Name", cell: (connector) => <span className="font-medium">{connector.name}</span>, isRowHeader: true },
          { id: "url", header: "URL", cell: (connector) => <span className="break-all text-muted">{connector.url}</span> },
          { id: "remove", header: "Remove", cell: (connector) => <Button variant="ghost" size="sm" aria-label={`Remove ${connector.name}`} isDisabled={remove.isPending} onPress={() => void removeAfterConfirm(connector.name)}>Remove</Button> },
        ]}
      />
      <TextField label="Name" value={name} onChange={setName} maxLength={100} />
      <TextField label="URL" type="url" value={url} onChange={setUrl} placeholder="https://example.com/mcp" maxLength={2048} />
      <TextField label="Token (optional)" type="password" autoComplete="new-password" value={token} onChange={setToken} maxLength={8192} />
      <div>
        <Button variant="secondary" size="sm" isDisabled={!name.trim() || !url.trim() || add.isPending} onPress={() => add.mutate()}>Add connector</Button>
      </div>
    </SettingsGroup>
  );
}
