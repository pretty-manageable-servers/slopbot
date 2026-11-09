// MCP connections: the remote MCP servers this server's Slopbot connects to, and which of their tools it may call.
// Ported from web/app.js renderMcp. Writes go to POST /api/mcp, which answers { text, mcp }. Connections open in a
// dialog from their table row; the add form is a dialog from the Add button.
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Badge, Button, Disclosure, Modal } from "agentic-ui-kit";
import { useState, type ReactNode } from "react";
import { post } from "../../api";
import type { McpBody, McpConnection, McpSnapshot, McpTool, ServerSnapshot } from "../../api-types";
import { settingsQuery, useServer } from "../../data";
import { NumberField, TextField } from "../../ui/text-field";
import { Select, type Option } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Table, type Column } from "../../ui/table";
import { confirmAction, notify, notifyError } from "../../ui/feedback";
import { SectionNote, SettingsGroup, SettingsRow } from "../../ui/layout";
import {
  CONCURRENCY, TIMEOUT_MS, connectionReady, draftFromConnection, hostOf, inRange, isConnectionId, newConnectionBody, newConnectionReady,
  saveConnectionBody, type Access, type ConnectionDraft, type Effect, type NewConnectionDraft, type ToolChoice, type Transport,
} from "./mcp-form";

interface McpAnswer { text: string; mcp: McpSnapshot }
/** Sends one write. `done` runs when the bot accepted it, to close the dialog. */
type Send = (body: Omit<McpBody, "server">, done: () => void) => void;

const TRANSPORTS: readonly Option<Transport>[] = [{ id: "http", label: "Streamable HTTP" }, { id: "sse", label: "Legacy SSE" }];
const ACCESS: readonly Option<Access>[] = [{ id: "admin", label: "Server admins" }, { id: "member", label: "Server members" }];
const EFFECTS: readonly Option<Effect>[] = [{ id: "write", label: "Write, requires a task thread" }, { id: "read", label: "Read only, safe to retry" }];
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
        <Table label="MCP connections" columns={COLUMNS} rows={mcp.connections} rowKey={(c) => c.id} onRowPress={(c) => setEditing(c.id)} empty="No MCP connections yet." />
      </SettingsGroup>

      <Modal isOpen={adding} onOpenChange={(open) => { if (!open) setAdding(false); }} title="Add a connection" className="max-w-lg">
        {adding && <AddForm credentialsEnabled={mcp.credentialsEnabled} pending={write.isPending} send={send} close={() => setAdding(false)} />}
      </Modal>
      <Modal isOpen={connection !== undefined} onOpenChange={(open) => { if (!open) setEditing(null); }} title={connection?.id} className="max-w-xl">
        {connection && <EditForm connection={connection} credentialsEnabled={mcp.credentialsEnabled} pending={write.isPending} send={send} close={() => setEditing(null)} />}
      </Modal>
    </>
  );
}

const COLUMNS: Column<McpConnection>[] = [
  { id: "id", label: "Connection", cell: (c) => <span className="font-medium">{c.id}</span> },
  { id: "endpoint", label: "Endpoint", cell: (c) => <span className="text-chat-muted">{hostOf(c.url)}</span> },
  { id: "transport", label: "Transport", cell: (c) => TRANSPORTS.find((t) => t.id === c.transport)?.label },
  { id: "status", label: "Status", cell: (c) => <Status connection={c} /> },
];

function Status({ connection }: { connection: McpConnection }) {
  if (connection.status !== "error") return <span className={connection.status === "connected" ? "" : "text-chat-muted"}>{STATUS_LABEL[connection.status]}</span>;
  return (
    <span className="flex flex-col items-start gap-1">
      <Badge tone="warning">{STATUS_LABEL.error}</Badge>
      {connection.error && <span className="text-xs text-chat-muted">{connection.error}</span>}
    </span>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="m-0 text-sm text-chat-muted">{children}</p>;
}

interface Endpoint { url: string; transport: Transport }

function EndpointFields({ value, onChange }: { value: Endpoint; onChange: (next: Partial<Endpoint>) => void }) {
  return (
    <>
      <TextField label="MCP endpoint" showLabel type="url" value={value.url} onChange={(url) => onChange({ url })} maxLength={2048} placeholder="https://example.com/mcp" required />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Transport</span>
        <Select label="Transport" options={TRANSPORTS} value={value.transport} onChange={(transport) => onChange({ transport })} />
      </div>
    </>
  );
}

/** The bearer token. Saving one needs the operator's MCP_SECRET_KEY, as in the old console. */
function TokenField({ value, onChange, credentialsEnabled, hasToken, disabled }: {
  value: string; onChange: (token: string) => void; credentialsEnabled: boolean; hasToken: boolean; disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <TextField label="Bearer token" showLabel type="password" autoComplete="new-password" maxLength={8192} value={value} onChange={onChange}
        disabled={!credentialsEnabled || disabled} placeholder={hasToken ? "Saved securely. Leave blank to keep." : "Optional"} />
      {!credentialsEnabled && <Hint>The operator must configure MCP_SECRET_KEY once before tokens can be saved. Public servers can be connected without a token.</Hint>}
    </div>
  );
}

function AddForm({ credentialsEnabled, pending, send, close }: { credentialsEnabled: boolean; pending: boolean; send: Send; close: () => void }) {
  const [draft, setDraft] = useState<NewConnectionDraft>({ id: "", url: "", transport: "http", token: "" });
  const patch = (next: Partial<NewConnectionDraft>) => setDraft((d) => ({ ...d, ...next }));
  const ready = newConnectionReady(draft);
  return (
    <form className="flex flex-col gap-4 px-5 pb-5" onSubmit={(event) => { event.preventDefault(); if (ready) send(newConnectionBody(draft), close); }}>
      <Hint>Applies to this server.</Hint>
      <div className="flex flex-col gap-1">
        <TextField label="Connection ID" showLabel value={draft.id} onChange={(id) => patch({ id })} maxLength={12} placeholder="github" required />
        {draft.id !== "" && !isConnectionId(draft.id) && <Hint>1–12 lowercase letters, numbers, or underscores, starting with a letter.</Hint>}
      </div>
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
    if (!(await confirmAction({ title: "Remove this connection?", body: "Its saved credential is removed too.", confirmLabel: "Remove", danger: true }))) return;
    send({ action: "remove", id: connection.id }, close);
  };
  return (
    <form className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-5 pb-5"
      onSubmit={(event) => { event.preventDefault(); if (ready) send(saveConnectionBody(connection, draft), close); }}>
      <div><Status connection={connection} /></div>
      <EndpointFields value={draft} onChange={patch} />
      <TokenField value={draft.token} onChange={(token) => patch({ token })} credentialsEnabled={credentialsEnabled} hasToken={connection.hasToken} disabled={draft.removeToken} />
      {connection.hasToken && (
        <SettingsRow label="Remove saved token">
          <Switch label="Remove saved token" checked={draft.removeToken} onChange={(removeToken) => patch({ removeToken })} />
        </SettingsRow>
      )}
      <SettingsRow label="Enable connection">
        <Switch label="Enable connection" checked={draft.enabled} onChange={(enabled) => patch({ enabled })} />
      </SettingsRow>
      <div className="flex flex-wrap gap-4">
        <NumberField label="Call timeout, milliseconds" showLabel value={draft.timeoutMs} onChange={(timeoutMs) => patch({ timeoutMs })} />
        <NumberField label="Concurrent calls" showLabel value={draft.concurrency} onChange={(concurrency) => patch({ concurrency })} />
      </div>
      {(!inRange(draft.timeoutMs, TIMEOUT_MS) || !inRange(draft.concurrency, CONCURRENCY)) && (
        <Hint>Timeout must be 1000 to 60000 milliseconds, and concurrent calls 1 to 16.</Hint>
      )}
      <section className="flex flex-col gap-1">
        <h4 className="m-0 text-sm font-semibold">Tools</h4>
        <Hint>Enabled tools use the connection account. Member access allows server members to use that account through Slopbot. Mark an operation read-only only when it cannot change remote state.</Hint>
        {tools.length ? (
          <div className="flex flex-col divide-y divide-chat-divider">
            {tools.map((tool) => <ToolRow key={tool.name} tool={tool} choice={draft.tools[tool.name]!} onChange={(choice) => setTool(tool.name, choice)} />)}
          </div>
        ) : <Hint>No tools discovered yet. Refresh this connection to discover tools. Newly discovered tools are disabled until selected.</Hint>}
      </section>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-chat-divider pt-4">
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" isDisabled={pending} onPress={() => send({ action: "refresh", id: connection.id }, close)}>Refresh tools / reconnect</Button>
          <Button variant="ghost" size="sm" isDisabled={pending} onPress={() => send({ action: "disable", id: connection.id }, close)}>Disable connection</Button>
          <Button variant="ghost" size="sm" isDisabled={pending} onPress={remove} className="text-chat-danger">Remove connection</Button>
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
    <div className="flex items-start gap-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium">{tool.name}</span>
        <code className="text-xs text-chat-muted">{tool.registeredName}</code>
        {tool.description && <p className="m-0 text-sm text-chat-muted">{tool.description}</p>}
        {tool.needsReview && <p className="m-0 text-sm text-chat-danger">Definition changed. Review and select this tool again to enable it.</p>}
        <div className="mt-1 flex flex-wrap gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-chat-muted">Access</span>
            <Select label={`Access to ${tool.name}`} options={ACCESS} value={choice.access} onChange={(access) => onChange({ ...choice, access })} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-chat-muted">Operation</span>
            <Select label={`Operation of ${tool.name}`} options={EFFECTS} value={choice.effect} onChange={(effect) => onChange({ ...choice, effect })} />
          </div>
        </div>
        {tool.inputSchema !== undefined && (
          <Disclosure summary="Tool schemas" className="mt-1">
            <pre className="m-0 overflow-x-auto rounded-chat-sm bg-chat-code-bg p-2 text-xs">{JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema ?? null }, null, 2)}</pre>
          </Disclosure>
        )}
      </div>
      <Switch label={`Enable ${tool.name}`} checked={choice.enabled} onChange={(enabled) => onChange({ ...choice, enabled })} />
    </div>
  );
}
