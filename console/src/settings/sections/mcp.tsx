// MCP connections: the remote MCP servers this server's Slopbot connects to, and which of their tools it may call.
// Ported from web/app.js renderMcp. Writes go to POST /api/mcp, which answers { text, mcp }. Connections open in a
// dialog from their table row; the add form is a dialog from the Add button.
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Badge, Button, confirm, DataTable, Disclosure, Modal, NumberField, Select, SettingsGroup, SettingsRow, Switch, TextField } from "slop-ui-components";
import { useState } from "react";
import { post } from "../../api";
import type { McpBody, McpConnection, McpSnapshot, McpTool, ServerSnapshot } from "../../api-types";
import { settingsQuery, useServer } from "../../data";
import { notify, notifyError } from "../../ui/feedback";
import { SectionNote } from "../../ui/layout";
import {
  CONCURRENCY, TIMEOUT_MS, connectionReady, draftFromConnection, hostOf, inRange, isConnectionId, newConnectionBody, newConnectionReady,
  saveConnectionBody, type Access, type ConnectionDraft, type Effect, type NewConnectionDraft, type ToolChoice, type Transport,
} from "./mcp-form";

interface McpAnswer { text: string; mcp: McpSnapshot }
/** Sends one write. `done` runs when the bot accepted it, to close the dialog. */
type Send = (body: Omit<McpBody, "server">, done: () => void) => void;

const TRANSPORTS = [{ id: "http", label: "Streamable HTTP" }, { id: "sse", label: "Legacy SSE" }] as const;
const ACCESS = [{ id: "admin", label: "Server admins" }, { id: "member", label: "Server members" }] as const;
const EFFECTS = [{ id: "write", label: "Write, requires a task thread" }, { id: "read", label: "Read only, safe to retry" }] as const;
const STATUS_LABEL: Record<McpConnection["status"], string> = { connected: "Connected", disabled: "Disabled", error: "Error" };

export default function McpConnections() {
  const server = useServer();
  const { data: snapshot } = useSuspenseQuery(settingsQuery(server.id));
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const write = useMutation({
    mutationFn: (body: Omit<McpBody, "server">) => post<McpAnswer>("/api/mcp", { server: server.id, ...body }),
    onSuccess: ({ text, mcp }) => {
      notify(text);
      client.setQueryData<ServerSnapshot>(["settings", server.id], (old) => old && { ...old, mcp });
    },
    onError: notifyError,
  });
  const send: Send = (body, done) => write.mutate(body, { onSuccess: done });

  const mcp = snapshot.mcp;
  if (!snapshot.admin || !mcp) return <SectionNote>Manage Server permission is required for these controls.</SectionNote>;
  const connection = mcp.connections.find((c) => c.id === editing);

  return (
    <>
      <SettingsGroup
        title="Connections"
        description="Add remote MCP servers and choose their tools. Changes apply without restarting or redeploying Slopbot."
        actions={<Button variant="outline" size="sm" onPress={() => setAdding(true)}>Add</Button>}
      >
        <DataTable
          aria-label="MCP connections"
          rows={mcp.connections}
          rowKey={(c) => c.id}
          onRowPress={(c) => setEditing(c.id)}
          emptyState="No MCP connections yet."
          columns={[
            { id: "id", header: "Connection", cell: (c) => <span className="font-medium">{c.id}</span> },
            { id: "endpoint", header: "Endpoint", cell: (c) => <span className="text-muted">{hostOf(c.url)}</span> },
            { id: "transport", header: "Transport", cell: (c) => TRANSPORTS.find((t) => t.id === c.transport)?.label },
            { id: "status", header: "Status", cell: (c) => <Status connection={c} />, cellClassName: "h-auto py-2 whitespace-normal" },
          ]}
        />
      </SettingsGroup>

      <Modal isOpen={adding} onOpenChange={(open) => { if (!open) setAdding(false); }} title="Add a connection" description="Applies to this server.">
        {adding && <AddForm credentialsEnabled={mcp.credentialsEnabled} pending={write.isPending} send={send} close={() => setAdding(false)} />}
      </Modal>
      <Modal isOpen={connection !== undefined} onOpenChange={(open) => { if (!open) setEditing(null); }} title={connection?.id} size="lg">
        {connection && <EditForm connection={connection} credentialsEnabled={mcp.credentialsEnabled} pending={write.isPending} send={send} close={() => setEditing(null)} />}
      </Modal>
    </>
  );
}

function Status({ connection }: { connection: McpConnection }) {
  if (connection.status !== "error") return <span className={connection.status === "connected" ? "" : "text-muted"}>{STATUS_LABEL[connection.status]}</span>;
  return (
    <span className="flex flex-col items-start gap-1">
      <Badge tone="warning">{STATUS_LABEL.error}</Badge>
      {connection.error && <span className="text-ui-sm text-muted">{connection.error}</span>}
    </span>
  );
}

interface Endpoint { url: string; transport: Transport }

function EndpointFields({ value, onChange }: { value: Endpoint; onChange: (next: Partial<Endpoint>) => void }) {
  return (
    <>
      <TextField label="MCP endpoint" type="url" value={value.url} onChange={(url) => onChange({ url })} maxLength={2048} placeholder="https://example.com/mcp" isRequired />
      <Select label="Transport" options={TRANSPORTS} value={value.transport} onChange={(transport) => onChange({ transport: transport })} />
    </>
  );
}

/** The bearer token. Saving one needs the operator's MCP_SECRET_KEY, as in the old console. */
function TokenField({ value, onChange, credentialsEnabled, hasToken, disabled }: {
  value: string; onChange: (token: string) => void; credentialsEnabled: boolean; hasToken: boolean; disabled?: boolean;
}) {
  return (
    <TextField label="Bearer token" type="password" autoComplete="new-password" maxLength={8192} value={value} onChange={onChange}
      isDisabled={!credentialsEnabled || disabled} placeholder={hasToken ? "Saved securely. Leave blank to keep." : "Optional"}
      description={credentialsEnabled ? undefined : "The operator must configure MCP_SECRET_KEY once before tokens can be saved. Public servers can be connected without a token."} />
  );
}

function AddForm({ credentialsEnabled, pending, send, close }: { credentialsEnabled: boolean; pending: boolean; send: Send; close: () => void }) {
  const [draft, setDraft] = useState<NewConnectionDraft>({ id: "", url: "", transport: "http", token: "" });
  const patch = (next: Partial<NewConnectionDraft>) => setDraft((d) => ({ ...d, ...next }));
  const ready = newConnectionReady(draft);
  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (ready) send(newConnectionBody(draft), close); }}>
      <TextField label="Connection ID" value={draft.id} onChange={(id) => patch({ id })} maxLength={12} placeholder="github" isRequired
        errorMessage={draft.id !== "" && !isConnectionId(draft.id) ? "1–12 lowercase letters, numbers, or underscores, starting with a letter." : undefined} />
      <EndpointFields value={draft} onChange={patch} />
      <TokenField value={draft.token} onChange={(token) => patch({ token })} credentialsEnabled={credentialsEnabled} hasToken={false} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onPress={close}>Cancel</Button>
        <Button type="submit" variant="primary" isDisabled={!ready || pending}>Connect and discover</Button>
      </div>
    </form>
  );
}

function EditForm({ connection, credentialsEnabled, pending, send, close }: {
  connection: McpConnection; credentialsEnabled: boolean; pending: boolean; send: Send; close: () => void;
}) {
  const [draft, setDraft] = useState(() => draftFromConnection(connection));
  const patch = (next: Partial<ConnectionDraft>) => setDraft((d) => ({ ...d, ...next }));
  const setTool = (name: string, choice: ToolChoice) => setDraft((d) => ({ ...d, tools: { ...d.tools, [name]: choice } }));
  const ready = connectionReady(draft);
  const tools: McpTool[] = connection.tools;
  const remove = async () => {
    if (!(await confirm({ title: "Remove this connection?", description: "Its saved credential is removed too.", confirmLabel: "Remove", destructive: true }))) return;
    send({ action: "remove", id: connection.id }, close);
  };
  return (
    <form className="flex flex-col gap-4"
      onSubmit={(event) => { event.preventDefault(); if (ready) send(saveConnectionBody(connection, draft), close); }}>
      <div><Status connection={connection} /></div>
      <EndpointFields value={draft} onChange={patch} />
      <TokenField value={draft.token} onChange={(token) => patch({ token })} credentialsEnabled={credentialsEnabled} hasToken={connection.hasToken} disabled={draft.removeToken} />
      {connection.hasToken && (
        <Switch toggleSide="end" isSelected={draft.removeToken} onChange={(removeToken) => patch({ removeToken })}>Remove saved token</Switch>
      )}
      <Switch toggleSide="end" isSelected={draft.enabled} onChange={(enabled) => patch({ enabled })}>Enable connection</Switch>
      <div className="flex flex-wrap gap-4">
        <NumberField label="Call timeout, milliseconds" errorMessage={inRange(draft.timeoutMs, TIMEOUT_MS) ? undefined : "Timeout must be 1000 to 60000 milliseconds."} value={draft.timeoutMs} onChange={(timeoutMs) => patch({ timeoutMs })} />
        <NumberField label="Concurrent calls" errorMessage={inRange(draft.concurrency, CONCURRENCY) ? undefined : "Concurrent calls must be 1 to 16."} value={draft.concurrency} onChange={(concurrency) => patch({ concurrency })} />
      </div>
      <SettingsGroup title="Tools" description={`Enabled tools use the connection account. Member access allows server members to use that account through Slopbot. Mark an operation read-only only when it cannot change remote state.${tools.length ? "" : " No tools discovered yet. Refresh this connection to discover tools. Newly discovered tools are disabled until selected."}`}>
        {tools.map((tool) => <ToolRow key={tool.name} tool={tool} choice={draft.tools[tool.name]!} onChange={(choice) => setTool(tool.name, choice)} />)}
      </SettingsGroup>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-divider pt-4">
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" isDisabled={pending} onPress={() => send({ action: "refresh", id: connection.id }, close)}>Refresh tools / reconnect</Button>
          <Button variant="ghost" size="sm" isDisabled={pending} onPress={() => send({ action: "disable", id: connection.id }, close)}>Disable connection</Button>
          <Button variant="ghost" size="sm" isDisabled={pending} onPress={remove} className="text-danger">Remove connection</Button>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onPress={close}>Cancel</Button>
          <Button type="submit" variant="primary" isDisabled={!ready || pending}>Apply connection and tools</Button>
        </div>
      </div>
    </form>
  );
}

function ToolRow({ tool, choice, onChange }: { tool: McpTool; choice: ToolChoice; onChange: (choice: ToolChoice) => void }) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-ui font-medium">{tool.name}</span>
        <code className="text-ui-sm text-muted">{tool.registeredName}</code>
        {tool.description && <p className="m-0 text-ui text-muted">{tool.description}</p>}
        {tool.needsReview && <p className="m-0 text-ui text-danger">Definition changed. Review and select this tool again to enable it.</p>}
        <div className="mt-1 flex flex-wrap gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-ui-sm text-muted">Access</span>
            <Select variant="quiet" aria-label={`Access to ${tool.name}`} options={ACCESS} value={choice.access} onChange={(access) => onChange({ ...choice, access: access })} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-ui-sm text-muted">Operation</span>
            <Select variant="quiet" aria-label={`Operation of ${tool.name}`} options={EFFECTS} value={choice.effect} onChange={(effect) => onChange({ ...choice, effect: effect })} />
          </div>
        </div>
        {tool.inputSchema !== undefined && (
          <Disclosure title="Tool schemas" className="mt-1">
            <pre className="m-0 overflow-x-auto rounded-sm bg-track p-2 text-ui-sm">{JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema ?? null }, null, 2)}</pre>
          </Disclosure>
        )}
      </div>
      <Switch aria-label={`Enable ${tool.name}`} isSelected={choice.enabled} onChange={(enabled) => onChange({ ...choice, enabled })} />
    </div>
  );
}
