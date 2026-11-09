// Bot settings (Slopbot team only): the system prompt for all servers, the team's web search keys, and the model
// service (the mode, the circuit breaker and the backup model). Ported from the old console's admin Bot tab. The
// rules and texts that can be tested are in bot-format.ts.
import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Badge, Button, Markdown, Modal, SegmentedControl } from "agentic-ui-kit";
import { useState } from "react";
import { get, post } from "../../api";
import type { Breaker, KeyedProvider, Llm, LlmOverride, SystemPrompt, WebKey, WebKeys } from "../../api-types";
import { adminMeQuery } from "../../data";
import { notify, notifyError, confirmAction } from "../../ui/feedback";
import { NumberField, TextArea, TextField } from "../../ui/text-field";
import { Select, type Option } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Table, type Column } from "../../ui/table";
import { SettingsGroup, SettingsRow } from "../../ui/layout";
import {
  PROVIDER_NAMES, addKeyBody, backupKeyText, capsProblem, keyErrorText, llmBody, llmFormFrom, llmProblem, llmStateText, secretProblem,
  type LlmBody, type LlmForm,
} from "./bot-format";

const promptQuery = queryOptions({ queryKey: ["admin", "system-prompt"], queryFn: () => get<SystemPrompt>("/api/admin/system-prompt") });
const fullPromptQuery = queryOptions({ queryKey: ["admin", "system-prompt", "full"], queryFn: () => get<{ text: string }>("/api/admin/system-prompt/full").then((r) => r.text) });
const webKeysQuery = queryOptions({ queryKey: ["admin", "web-keys"], queryFn: () => get<WebKeys>("/api/admin/web-keys") });
const llmQuery = queryOptions({ queryKey: ["admin", "llm"], queryFn: () => get<Llm>("/api/admin/llm") });

interface LlmTest { ok: boolean; code?: string; ms: number }
type Caps = Record<KeyedProvider, number>;

const PROVIDERS: Option<KeyedProvider>[] = [{ id: "tavily", label: "Tavily" }, { id: "firecrawl", label: "Firecrawl" }];
const OVERRIDES: Option<LlmOverride>[] = [
  { id: "auto", label: "Auto (the breaker decides)" },
  { id: "normal", label: "Normal" },
  { id: "fallback", label: "Backup model" },
  { id: "offline", label: "Offline" },
];

export default function Section() {
  const { data: team } = useSuspenseQuery(adminMeQuery);
  const edit = team?.canEdit === true;
  return (
    <>
      <SystemPromptGroup edit={edit} />
      <WebKeysGroup edit={edit} />
      <ModelGroup edit={edit} />
    </>
  );
}

type PromptView = "write" | "preview";
const PROMPT_VIEWS: { id: PromptView; label: string }[] = [{ id: "write", label: "Write" }, { id: "preview", label: "Preview" }];

function SystemPromptGroup({ edit }: { edit: boolean }) {
  const client = useQueryClient();
  const { data: prompt } = useSuspenseQuery(promptQuery);
  const [draft, setDraft] = useState(prompt.text ?? prompt.default);
  const [view, setView] = useState<PromptView>("write");
  const [showFull, setShowFull] = useState(false);
  const full = useQuery({ ...fullPromptQuery, enabled: showFull });
  const save = useMutation({
    mutationFn: (text: string) => post<SystemPrompt>("/api/admin/system-prompt", { text }),
    onSuccess: (saved) => {
      client.setQueryData(promptQuery.queryKey, saved);
      client.invalidateQueries({ queryKey: fullPromptQuery.queryKey });
      setDraft(saved.text ?? saved.default);
      notify(saved.text === null ? "The default system prompt is in use." : "System prompt saved.");
    },
    onError: notifyError,
  });
  const useDefault = async () => {
    if (!await confirmAction({ title: "Use the default prompt?", body: "The saved prompt is removed for all servers. The default applies to new replies.", confirmLabel: "Use default", danger: true })) return;
    setDraft(prompt.default);
    save.mutate("");
  };

  return (
    <SettingsGroup title="System prompt" description="For all servers. Empty uses the default."
      actions={edit && <Button variant="subtle" size="sm" isDisabled={save.isPending} onPress={() => save.mutate(draft.trim())}>Save</Button>}>
      <SettingsRow stack label="Instructions">
        <div className="flex flex-col gap-1">
          <SegmentedControl label="Editor view" options={PROMPT_VIEWS} value={view} onChange={setView} className="self-start" />
          {view === "preview"
            ? <div className="min-h-60 rounded-chat-sm border border-chat-border bg-chat-surface px-2.5 py-1.5 text-sm">
                <Markdown>{draft.trim() ? draft : prompt.default}</Markdown>
              </div>
            : <TextArea label="Instructions" value={draft} onChange={setDraft} maxLength={prompt.max} rows={10} disabled={!edit} />}
          <p className="m-0 text-right text-xs text-chat-muted" aria-live="polite">{draft.length} / {prompt.max}</p>
        </div>
      </SettingsRow>
      <SettingsRow label="Default prompt" help="Replaces the saved prompt for all servers.">
        <Button variant="outline" size="sm" isDisabled={!edit || save.isPending} onPress={useDefault}>Use default</Button>
      </SettingsRow>
      <SettingsRow label="Full prompt" help="Read only. The tool list is sent as function definitions with their schemas, which are not shown here.">
        <Button variant="outline" size="sm" onPress={() => setShowFull(true)}>Show the full prompt</Button>
      </SettingsRow>
      <Modal isOpen={showFull} onOpenChange={setShowFull} title="Full prompt the model gets" className="max-w-2xl">
        <div className="px-5 pb-5 text-sm">
          {full.error ? <p className="m-0 text-chat-danger">{full.error.message}</p>
            : full.data === undefined ? <p className="m-0 text-chat-muted">Loading…</p>
            : <Markdown>{full.data}</Markdown>}
        </div>
      </Modal>
    </SettingsGroup>
  );
}

function WebKeysGroup({ edit }: { edit: boolean }) {
  const client = useQueryClient();
  const { data: webKeys } = useSuspenseQuery(webKeysQuery);
  const [adding, setAdding] = useState(false);
  const [caps, setCaps] = useState<Caps>(webKeys.caps);
  const keep = (next: WebKeys) => client.setQueryData(webKeysQuery.queryKey, next);
  const remove = useMutation({
    mutationFn: (id: string) => post<WebKeys>("/api/admin/web-keys/delete", { id }),
    onSuccess: (next) => { keep(next); notify("Key removed."); },
    onError: notifyError,
  });
  const reset = useMutation({
    mutationFn: (id: string) => post<WebKeys>("/api/admin/web-keys/reset", { id }),
    onSuccess: (next) => { keep(next); notify("Key reset."); },
    onError: notifyError,
  });
  const saveCaps = useMutation({
    mutationFn: (body: Caps) => post<Caps>("/api/admin/web-keys/caps", body),
    onSuccess: (next) => {
      client.setQueryData<WebKeys>(webKeysQuery.queryKey, (old) => old && { ...old, caps: next });
      setCaps(next);
      notify("Key caps saved.");
    },
    onError: notifyError,
  });
  const askRemove = async (key: WebKey) => {
    if (await confirmAction({ title: "Delete this key?", body: "Slopbot stops using it at once.", confirmLabel: "Delete", danger: true })) remove.mutate(key.id);
  };
  const saveCapsNow = () => {
    const problem = capsProblem(caps);
    if (problem) return notify(problem, "error");
    saveCaps.mutate(caps);
  };

  const columns: Column<WebKey>[] = [
    { id: "provider", label: "Service", cell: (key) => PROVIDER_NAMES[key.provider] },
    { id: "label", label: "Label", cell: (key) => key.label || PROVIDER_NAMES[key.provider] },
    { id: "key", label: "Key", cell: (key) => <code>••••{key.last4}</code> },
    { id: "owner", label: "Added by", cell: (key) => (key.mine ? "You" : <code>{key.owner}</code>) },
    { id: "used", label: "Used this month", align: "right", cell: (key) => `${key.used} / ${webKeys.caps[key.provider]} credits` },
    {
      id: "status", label: "Status", cell: (key) => (
        <div className="flex flex-col items-start gap-1">
          {key.exhausted && <Badge tone="warning">Out of credits</Badge>}
          {key.lastError && <span className={`text-xs ${key.lastError.exhausted ? "text-chat-danger" : "text-chat-muted"}`}>{keyErrorText(key.lastError)}</span>}
        </div>
      ),
    },
    {
      id: "actions", label: "Actions", hideLabel: true, align: "right", cell: (key) => (
        <div className="flex justify-end gap-1">
          {edit && (key.exhausted || key.lastError) && <Button variant="ghost" size="sm" isDisabled={reset.isPending} onPress={() => reset.mutate(key.id)}>Reset</Button>}
          {(key.mine || edit) && <Button variant="ghost" size="sm" isDisabled={remove.isPending} onPress={() => askRemove(key)}>Delete</Button>}
        </div>
      ),
    },
  ];

  return (
    <SettingsGroup title="Web search keys" description="Team keys for Tavily and Firecrawl. You can delete your own keys. Editors can delete any key."
      actions={<Button variant="subtle" size="sm" isDisabled={!webKeys.enabled} onPress={() => setAdding(true)}>Add key</Button>}>
      <SettingsRow label="Web search" help={`Usage counts per key for ${webKeys.month}.`}>
        <Badge tone={webKeys.enabled ? undefined : "warning"}>{webKeys.enabled ? "On" : "Off"}</Badge>
      </SettingsRow>
      {!webKeys.enabled && (
        <p role="status" className="m-0 py-3 text-sm text-chat-muted">
          Web search keys are off. The operator must set WEB_KEYS_SECRET on the server, then restart Slopbot. Until then no key can be added.
        </p>
      )}
      <div className="py-3">
        <Table label="Web search keys" columns={columns} rows={webKeys.keys} rowKey={(key) => key.id} empty="No keys yet." />
      </div>
      <SettingsRow label="Monthly cap per key" help="Credits one key may use each month before Slopbot moves on to another key.">
        {edit ? (
          <div className="flex flex-wrap items-end gap-2">
            {PROVIDERS.map((p) => (
              <NumberField key={p.id} label={`${p.label} credits`} showLabel value={caps[p.id]} className="w-28"
                onChange={(value) => setCaps((c) => ({ ...c, [p.id]: value }))} />
            ))}
            <Button variant="subtle" size="sm" isDisabled={saveCaps.isPending} onPress={saveCapsNow}>Save</Button>
          </div>
        ) : (
          <span className="text-chat-muted">{PROVIDERS.map((p) => `${p.label} ${webKeys.caps[p.id]} credits`).join(", ")}</span>
        )}
      </SettingsRow>
      <AddKeyModal open={adding} onClose={() => setAdding(false)} onAdded={keep} enabled={webKeys.enabled} />
    </SettingsGroup>
  );
}

/** The add form. Any team member can add a key while web search keys are on. The secret leaves the field at once. */
function AddKeyModal({ open, onClose, onAdded, enabled }: { open: boolean; onClose: () => void; onAdded: (next: WebKeys) => void; enabled: boolean }) {
  const [provider, setProvider] = useState<KeyedProvider>("tavily");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const add = useMutation({
    mutationFn: (body: ReturnType<typeof addKeyBody>) => post<WebKeys>("/api/admin/web-keys/add", body),
    onSuccess: (next) => { onAdded(next); notify("Key added."); onClose(); setLabel(""); },
    onError: notifyError,
  });
  const submit = () => {
    const problem = secretProblem(secret);
    if (problem) return notify(problem, "error");
    add.mutate(addKeyBody({ provider, label, secret }));
    setSecret("");
  };

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Add a key" className="max-w-md">
      <div className="flex flex-col gap-3 px-5 pb-2 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span>Service</span>
          <Select label="Service" options={PROVIDERS} value={provider} onChange={setProvider} disabled={!enabled} />
        </div>
        <TextField label="Label (optional)" showLabel value={label} onChange={setLabel} maxLength={60} autoComplete="off" disabled={!enabled} />
        <TextField label="API key" showLabel type="password" value={secret} onChange={setSecret} maxLength={200} autoComplete="off" disabled={!enabled} />
        <p className="m-0 text-chat-muted">Only the last four characters show again. The key is not sent back to the browser.</p>
      </div>
      <div className="flex justify-end gap-2 px-5 pt-4 pb-4">
        <Button variant="ghost" onPress={onClose}>Cancel</Button>
        <Button variant="primary" isDisabled={!enabled || add.isPending} onPress={submit}>Add key</Button>
      </div>
    </Modal>
  );
}

const BREAKER_HELP = "After the failures in the window, Slopbot uses the backup model, or goes offline when no backup model is set. Slopbot sends no automatic test requests (the Test button sends one when an admin clicks it). After the cooldown, the next real request tries the main model again; each failed try doubles the cooldown, up to the maximum.";

function ModelGroup({ edit }: { edit: boolean }) {
  const client = useQueryClient();
  const { data: llm } = useSuspenseQuery(llmQuery);
  const [form, setForm] = useState<LlmForm>(() => llmFormFrom(llm));
  const patch = (change: Partial<LlmForm>) => setForm((f) => ({ ...f, ...change }));
  const patchBackup = (change: Partial<LlmForm["backup"]>) => setForm((f) => ({ ...f, backup: { ...f.backup, ...change } }));
  const patchBreaker = (change: Partial<Breaker>) => setForm((f) => ({ ...f, breaker: { ...f.breaker, ...change } }));
  const save = useMutation({
    mutationFn: (body: LlmBody) => post<Llm>("/api/admin/llm", body),
    onSuccess: (next) => { client.setQueryData(llmQuery.queryKey, next); setForm(llmFormFrom(next)); notify("Model settings saved."); },
    onError: notifyError,
  });
  const test = useMutation({
    mutationFn: () => post<LlmTest>("/api/admin/llm/test"),
    onSuccess: (result) => notify(result.ok ? `OK in ${result.ms} ms.` : `The backup model failed${result.code ? ` (${result.code})` : ""} after ${result.ms} ms.`, result.ok ? "info" : "error"),
    onError: notifyError,
  });
  const submit = () => {
    const problem = llmProblem(form);
    if (problem) return notify(problem, "error");
    save.mutate(llmBody(form));
  };
  const { fallback } = llm.settings;

  return (
    <SettingsGroup title="Model" description="Slopbot's own models and the backup model. Applies to all servers."
      actions={edit && <Button variant="subtle" size="sm" isDisabled={save.isPending} onPress={submit}>Save</Button>}>
      <p className="m-0 py-3 text-sm">{llmStateText(llm.state)}</p>
      <SettingsRow label="Mode">
        <Select label="Mode" options={OVERRIDES} value={form.override} onChange={(override) => patch({ override })} disabled={!edit} />
      </SettingsRow>

      <h4 className="m-0 pt-5 text-sm font-semibold">Circuit breaker</h4>
      <p className="m-0 pb-1 text-sm text-chat-muted">{BREAKER_HELP}</p>
      <SettingsRow label="Failures">
        <NumberField label="Failures" value={form.breaker.failures} onChange={(failures) => patchBreaker({ failures })} disabled={!edit} />
      </SettingsRow>
      <SettingsRow label="Window, seconds">
        <NumberField label="Window, seconds" value={form.breaker.windowSeconds} onChange={(windowSeconds) => patchBreaker({ windowSeconds })} disabled={!edit} />
      </SettingsRow>
      <SettingsRow label="Cooldown, seconds">
        <NumberField label="Cooldown, seconds" value={form.breaker.cooldownSeconds} onChange={(cooldownSeconds) => patchBreaker({ cooldownSeconds })} disabled={!edit} />
      </SettingsRow>
      <SettingsRow label="Max cooldown, seconds">
        <NumberField label="Max cooldown, seconds" value={form.breaker.maxCooldownSeconds} onChange={(maxCooldownSeconds) => patchBreaker({ maxCooldownSeconds })} disabled={!edit} />
      </SettingsRow>
      <SettingsRow label="Status note every, minutes">
        <NumberField label="Status note every, minutes" value={form.statusNoteMinutes} onChange={(statusNoteMinutes) => patch({ statusNoteMinutes })} disabled={!edit} />
      </SettingsRow>

      <h4 className="m-0 pt-5 text-sm font-semibold">Backup model</h4>
      <SettingsRow label="Base URL">
        <TextField label="Base URL" type="url" value={form.backup.baseUrl} onChange={(baseUrl) => patchBackup({ baseUrl })} placeholder="https://models.example.com/v1" maxLength={300} disabled={!edit} className="w-64" />
      </SettingsRow>
      <SettingsRow label="Model">
        <TextField label="Model" value={form.backup.model} onChange={(model) => patchBackup({ model })} maxLength={200} disabled={!edit} className="w-64" />
      </SettingsRow>
      <SettingsRow label="Context tokens">
        <NumberField label="Context tokens" value={form.backup.contextTokens} onChange={(contextTokens) => patchBackup({ contextTokens })} disabled={!edit} />
      </SettingsRow>
      <SettingsRow label="Output tokens">
        <NumberField label="Output tokens" value={form.backup.outputTokens} onChange={(outputTokens) => patchBackup({ outputTokens })} disabled={!edit} />
      </SettingsRow>
      <SettingsRow label="Zero data retention (ZDR)" help="Untick ZDR for a cloud model. A cloud model answers only users who opted in (see Account).">
        <Switch label="Zero data retention (ZDR)" checked={form.backup.zdr} onChange={(zdr) => patchBackup({ zdr })} disabled={!edit} />
      </SettingsRow>
      <SettingsRow label="API key" help={backupKeyText(fallback)}>
        <div className="flex flex-wrap items-center gap-2">
          <TextField label="API key" type="password" value={form.key} onChange={(key) => patch({ key, clearKey: false })} autoComplete="off"
            placeholder={fallback?.keyLast4 ? `Saved (…${fallback.keyLast4}). Leave blank to keep` : "Paste the key"} disabled={!edit} className="w-64" />
          {edit && (form.clearKey
            ? <>
                <span className="text-sm text-chat-muted">Removed on save.</span>
                <Button variant="ghost" size="sm" onPress={() => patch({ clearKey: false })}>Keep key</Button>
              </>
            : fallback?.keyLast4 && <Button variant="ghost" size="sm" onPress={() => patch({ key: "", clearKey: true })}>Clear key</Button>)}
        </div>
      </SettingsRow>
      {edit && (
        <SettingsRow label="Test the backup model" help="The test uses the saved backup model. Save first.">
          <Button variant="outline" size="sm" isDisabled={test.isPending} onPress={() => test.mutate()}>Test</Button>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
