// Usage & limits (Slopbot team only): what each user may spend, model prices, replies to other bots, scheduled task
// caps, and lifetime usage. Ported from the old console's Bot admin and Users tab (web/app.js 473-660, 966-1024).
// Money, number and range rules are in limits-format.ts.
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery, type QueryKey } from "@tanstack/react-query";
import { Badge, Button } from "agentic-ui-kit";
import { useState } from "react";
import { get, post } from "../../api";
import type { BotReplies, LimitsView, ModelPrice, Prices, ScheduleLimits, UsageRow, UsageTotals } from "../../api-types";
import { adminMeQuery } from "../../data";
import { NumberField, TextField } from "../../ui/text-field";
import { Table, type Column } from "../../ui/table";
import { confirmAction, notify, notifyError } from "../../ui/feedback";
import { ServerMark, SettingsGroup, SettingsRow } from "../../ui/layout";
import {
  BOT_REPLY_RULES, LIMITS_RULES, PRICE_RULES, SCHEDULE_RULES, botRepliesBody, botRepliesForm, botRepliesIssues, checkFields,
  costText, count, dollarsOf, iconUrl, limitsBody, modelError, money, priceBody, priceLabel, scheduleBody, sharePercent,
  type BotRepliesForm, type Issues, type LimitsForm, type PriceForm, type ScheduleForm,
} from "./limits-format";

// The bot's admin routes (src/admin-panel.ts). Each POST answers the view its GET gives, and the answer goes into the cache.
// api-types' ScheduleLimits leaves out `default`, which the bot sends with it (admin-panel.ts scheduleLimits()).
type ScheduleView = ScheduleLimits & { default: ScheduleLimits };
type PriceRow = Prices["models"][number];
type ServerUsage = UsageTotals["servers"][number];
type ModelUsage = UsageTotals["models"][number];
type PriceKey = keyof PriceForm;

const limitsQuery = queryOptions({ queryKey: ["admin", "limits"], queryFn: () => get<LimitsView>("/api/admin/limits") });
const pricesQuery = queryOptions({ queryKey: ["admin", "prices"], queryFn: () => get<Prices>("/api/admin/prices") });
const botRepliesQuery = queryOptions({ queryKey: ["admin", "bot-replies"], queryFn: () => get<BotReplies>("/api/admin/bot-replies") });
const schedulesQuery = queryOptions({ queryKey: ["admin", "schedule-limits"], queryFn: () => get<ScheduleView>("/api/admin/schedule-limits") });
const totalsQuery = queryOptions({ queryKey: ["admin", "usage-total"], queryFn: () => get<UsageTotals>("/api/admin/usage/total") });

const PRICE_FIELDS: [PriceKey, string][] = [["input", "Input"], ["cached_input", "Cached input"], ["output", "Output"]];
const PRICE_LABELS: Record<string, string> = { model: "Model", input: "Input", cached_input: "Cached input", output: "Output" };

const limitsForm = (view: LimitsView): LimitsForm => ({ five: dollarsOf(view.five_hour_cost_micros), week: dollarsOf(view.week_cost_micros), grace: view.grace_percent });
const pricesForm = (price: ModelPrice): PriceForm => ({ input: dollarsOf(price.input), cached_input: dollarsOf(price.cached_input), output: dollarsOf(price.output) });
const scheduleForm = (view: ScheduleLimits): ScheduleForm => ({
  perServer: view.perServer, perUser: view.perUser, minMessage: view.minMinutes.message, minPrompt: view.minMinutes.prompt, minTool: view.minMinutes.tool,
});
const BLANK_PRICES: PriceForm = { input: Number.NaN, cached_input: Number.NaN, output: Number.NaN };

/** A save to one admin route. Its answer is the route's new view, so it goes straight into the cache. */
function useSave<T>(path: string, key: QueryKey) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: object) => post<T>(path, body),
    onSuccess: (view) => { client.setQueryData(key, view); notify("Saved."); },
    onError: notifyError,
  });
}

/** The help text, then the row's problem in red under it. The problem is passed only after a Save attempt. */
function Help({ text, error }: { text?: string; error?: string }) {
  return (
    <>
      {text}
      {error && <span role="alert" className="block text-chat-danger">{error}</span>}
    </>
  );
}

function SaveButton({ pending, onPress }: { pending: boolean; onPress: () => void }) {
  return <Button variant="subtle" size="sm" onPress={onPress} isDisabled={pending}>Save</Button>;
}

export default function Limits() {
  const { data: me } = useSuspenseQuery(adminMeQuery);
  const canEdit = me?.canEdit ?? false;
  return (
    <>
      <CostLimits canEdit={canEdit} />
      <ModelPrices canEdit={canEdit} />
      <BotReplyLimits canEdit={canEdit} />
      <ScheduleCaps canEdit={canEdit} />
      <TotalUsage />
    </>
  );
}

function CostLimits({ canEdit }: { canEdit: boolean }) {
  const { data } = useSuspenseQuery(limitsQuery);
  const save = useSave<LimitsView>("/api/admin/limits", limitsQuery.queryKey);
  const [form, setForm] = useState(() => limitsForm(data));
  const [tried, setTried] = useState(false);
  const issues = checkFields(form, LIMITS_RULES);
  const submit = () => {
    setTried(true);
    if (Object.keys(issues).length) return;
    save.mutate(limitsBody(form), { onSuccess: (view) => setForm(limitsForm(view)) });
  };
  const shown = tried ? issues : {};
  const defaults = data.defaults;
  return (
    <SettingsGroup title="Usage limits" description="For each user, across all servers. Zero means no limit." actions={canEdit && <SaveButton pending={save.isPending} onPress={submit} />}>
      <SettingsRow label="5-hour limit" help={<Help text={`In dollars. Default ${money(defaults.five_hour_cost_micros)}.`} error={shown.five} />}>
        <NumberField label="5-hour limit" value={form.five} onChange={(five) => setForm({ ...form, five })} disabled={!canEdit} />
      </SettingsRow>
      <SettingsRow label="Weekly limit" help={<Help text={`In dollars. Default ${money(defaults.week_cost_micros)}.`} error={shown.week} />}>
        <NumberField label="Weekly limit" value={form.week} onChange={(week) => setForm({ ...form, week })} disabled={!canEdit} />
      </SettingsRow>
      <SettingsRow label="Grace percent" help={<Help text={`Default ${defaults.grace_percent}%.`} error={shown.grace} />}>
        <NumberField label="Grace percent" value={form.grace} onChange={(grace) => setForm({ ...form, grace })} disabled={!canEdit} />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** Model prices: each row edits inline. Reset removes the override, so the default applies again. */
function ModelPrices({ canEdit }: { canEdit: boolean }) {
  const { data } = useSuspenseQuery(pricesQuery);
  const save = useSave<Prices>("/api/admin/prices", pricesQuery.queryKey);
  const [edit, setEdit] = useState<{ model: string; form: PriceForm; tried: boolean } | null>(null);
  const [added, setAdded] = useState({ model: "", form: BLANK_PRICES, tried: false });
  const editIssues = edit?.tried ? checkFields(edit.form, PRICE_RULES) : {};
  const modelProblem = modelError(added.model);
  const addIssues: Issues<"model" | PriceKey> = { ...checkFields(added.form, PRICE_RULES), ...(modelProblem ? { model: modelProblem } : {}) };
  const addError = added.tried ? Object.entries(addIssues).map(([field, message]) => `${PRICE_LABELS[field]}: ${message}`).join(" ") : undefined;

  const saveEdit = () => {
    if (!edit) return;
    setEdit({ ...edit, tried: true });
    if (Object.keys(checkFields(edit.form, PRICE_RULES)).length) return;
    save.mutate(priceBody(edit.model, edit.form), { onSuccess: () => setEdit(null) });
  };
  const addModel = () => {
    setAdded({ ...added, tried: true });
    if (Object.keys(addIssues).length) return;
    save.mutate(priceBody(added.model.trim(), added.form), { onSuccess: () => setAdded({ model: "", form: BLANK_PRICES, tried: false }) });
  };
  const resetPrice = async (model: string) => {
    if (!await confirmAction({ title: "Reset the price?", body: `The override for ${model} is removed. The default price applies again.`, confirmLabel: "Reset", danger: true })) return;
    save.mutate({ model, remove: true });
  };

  const fallback = data.fallback;
  const actions: Column<PriceRow> = {
    id: "actions",
    label: "Actions", hideLabel: true,
    align: "right",
    cell: (row) => edit?.model === row.model ? (
      <span className="flex justify-end gap-1">
        <Button variant="subtle" size="sm" onPress={saveEdit} isDisabled={save.isPending}>Save</Button>
        <Button variant="ghost" size="sm" onPress={() => setEdit(null)}>Cancel</Button>
      </span>
    ) : (
      <span className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" onPress={() => setEdit({ model: row.model, form: pricesForm(row.override ?? row.default), tried: false })}>Edit</Button>
        {row.override && <Button variant="ghost" size="sm" onPress={() => resetPrice(row.model)}>Reset</Button>}
      </span>
    ),
  };
  const columns: Column<PriceRow>[] = [
    { id: "model", label: "Model", cell: (row) => <span className="flex items-center gap-2"><code>{row.model}</code>{row.override && <Badge tone="outline">Override</Badge>}</span> },
    ...PRICE_FIELDS.map(([key, label]): Column<PriceRow> => ({
      id: key,
      label,
      align: "right",
      cell: (row) => edit?.model === row.model ? (
        <span className="inline-flex flex-col items-end gap-1">
          <NumberField label={`${label} for ${row.model}`} value={edit.form[key]} onChange={(value) => setEdit({ ...edit, form: { ...edit.form, [key]: value } })} className="w-24" />
          {editIssues[key] && <span role="alert" className="text-xs text-chat-danger">{editIssues[key]}</span>}
        </span>
      ) : <PriceText row={row} field={key} />,
    })),
    { id: "source", label: "Source", cell: (row) => <span className="text-chat-muted">{row.default.source === "fallback" ? "Fallback" : "Config"}</span> },
    ...(canEdit ? [actions] : []),
  ];

  return (
    <SettingsGroup
      title="Model prices"
      description={`Dollars per 1 million tokens, for all servers. Each model starts at its default: the configured price, or the fallback (${priceLabel(fallback.input)} input, ${priceLabel(fallback.cached_input)} cached input, ${priceLabel(fallback.output)} output) when none is set.`}
    >
      <Table label="Model prices" columns={columns} rows={data.models} rowKey={(row) => row.model} empty="No models yet." />
      {canEdit && (
        <SettingsRow label="Add a model" stack help={<Help text="Sets an override for a model that is not in the list." error={addError} />}>
          <div className="flex flex-wrap items-end gap-2">
            <TextField label="Model ID" value={added.model} onChange={(model) => setAdded({ ...added, model })} placeholder="Model ID" className="w-52" />
            {PRICE_FIELDS.map(([key, label]) => (
              <NumberField key={key} label={`${label} price for the new model`} value={added.form[key]} onChange={(value) => setAdded({ ...added, form: { ...added.form, [key]: value } })} className="w-24" />
            ))}
            <Button variant="subtle" size="sm" onPress={addModel} isDisabled={save.isPending}>Add</Button>
          </div>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/** The price in use. With an override that differs, the default is struck through and the override is bold. */
function PriceText({ row, field }: { row: PriceRow; field: PriceKey }) {
  if (!row.override || row.override[field] === row.default[field]) return <>{priceLabel(row.default[field])}</>;
  return (
    <>
      <s className="text-chat-muted">{priceLabel(row.default[field])}</s> <strong className="font-semibold">{priceLabel(row.override[field])}</strong>
    </>
  );
}

/** Replies to other bots, per channel. An optional temporary limit replaces this one for "Lasts" minutes. */
function BotReplyLimits({ canEdit }: { canEdit: boolean }) {
  const { data } = useSuspenseQuery(botRepliesQuery);
  const save = useSave<BotReplies>("/api/admin/bot-replies", botRepliesQuery.queryKey);
  const [form, setForm] = useState<BotRepliesForm>(() => botRepliesForm(data));
  const [tried, setTried] = useState(false);
  const issues = botRepliesIssues(form);
  const shown = tried ? issues : {};
  const saved = (view: BotReplies) => setForm(botRepliesForm(view));

  const submit = () => {
    setTried(true);
    if (Object.keys(issues).length) return;
    save.mutate(botRepliesBody(form), { onSuccess: saved });
  };
  const endTemporary = () => {
    setTried(true);
    if (Object.keys(checkFields(form, BOT_REPLY_RULES)).length) return;
    save.mutate({ replies: form.replies, minutes: form.minutes, temporary: null }, { onSuccess: saved });
  };

  const temporary = data.temporary;
  const defaults = data.default;
  const temporaryText = temporary
    ? `Now: ${temporary.replies} in ${temporary.minutes} minutes until ${new Date(temporary.until).toLocaleString()}. Then the limit above comes back.`
    : "None. A temporary limit replaces the limit above for some time, then the limit above comes back.";
  return (
    <SettingsGroup
      title="Bot replies"
      description={`For all servers, counted for each channel. Default: ${defaults.replies} in ${defaults.minutes} minutes. Zero replies stops all replies to bots.`}
      actions={canEdit && <SaveButton pending={save.isPending} onPress={submit} />}
    >
      <SettingsRow label="Replies" help={<Help text="Replies allowed in the window below." error={shown.replies} />}>
        <NumberField label="Replies" value={form.replies} onChange={(replies) => setForm({ ...form, replies })} disabled={!canEdit} />
      </SettingsRow>
      <SettingsRow label="Minutes" help={<Help text="The window the replies count in." error={shown.minutes} />}>
        <NumberField label="Minutes" value={form.minutes} onChange={(minutes) => setForm({ ...form, minutes })} disabled={!canEdit} />
      </SettingsRow>
      <SettingsRow label="Temporary limit" help={temporaryText}>
        {canEdit && temporary && <Button variant="outline" size="sm" onPress={endTemporary} isDisabled={save.isPending}>End temporary limit</Button>}
      </SettingsRow>
      <SettingsRow label="Temporary replies" help={<Help error={shown.tempReplies} />}>
        <NumberField label="Temporary replies" value={form.tempReplies} onChange={(tempReplies) => setForm({ ...form, tempReplies })} disabled={!canEdit} />
      </SettingsRow>
      <SettingsRow label="Temporary minutes" help={<Help error={shown.tempMinutes} />}>
        <NumberField label="Temporary minutes" value={form.tempMinutes} onChange={(tempMinutes) => setForm({ ...form, tempMinutes })} disabled={!canEdit} />
      </SettingsRow>
      <SettingsRow label="Lasts (minutes)" help={<Help text="How long the temporary limit lasts. Empty leaves the temporary limit as it is." error={shown.tempFor} />}>
        <NumberField label="Lasts (minutes)" value={form.tempFor} onChange={(tempFor) => setForm({ ...form, tempFor })} disabled={!canEdit} />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** Scheduled tasks: caps per server and per user, and the shortest interval for each kind of run. */
function ScheduleCaps({ canEdit }: { canEdit: boolean }) {
  const { data } = useSuspenseQuery(schedulesQuery);
  const save = useSave<ScheduleView>("/api/admin/schedule-limits", schedulesQuery.queryKey);
  const [form, setForm] = useState(() => scheduleForm(data));
  const [tried, setTried] = useState(false);
  const issues = checkFields(form, SCHEDULE_RULES);
  const submit = () => {
    setTried(true);
    if (Object.keys(issues).length) return;
    save.mutate(scheduleBody(form), { onSuccess: (view) => setForm(scheduleForm(view)) });
  };
  const shown = tried ? issues : {};
  const defaults = data.default;
  const rows: { key: keyof ScheduleForm; label: string; help: string }[] = [
    { key: "perServer", label: "Per server", help: `Default ${defaults.perServer}.` },
    { key: "perUser", label: "Per user", help: `Default ${defaults.perUser}.` },
    { key: "minMessage", label: "Minimum minutes: message", help: `Default ${defaults.minMinutes.message}.` },
    { key: "minPrompt", label: "Minimum minutes: prompt", help: `Default ${defaults.minMinutes.prompt}.` },
    { key: "minTool", label: "Minimum minutes: tool", help: `Default ${defaults.minMinutes.tool}.` },
  ];
  return (
    <SettingsGroup title="Schedules" description="For all servers. Caps the scheduled tasks each server and user may have, and how often each kind may run." actions={canEdit && <SaveButton pending={save.isPending} onPress={submit} />}>
      {rows.map(({ key, label, help }) => (
        <SettingsRow key={key} label={label} help={<Help text={help} error={shown[key]} />}>
          <NumberField label={label} value={form[key]} onChange={(value) => setForm({ ...form, [key]: value })} disabled={!canEdit} />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

/** Lifetime usage over all servers: the total, then the top servers and models by cost. */
function TotalUsage() {
  const { data } = useSuspenseQuery(totalsQuery);
  const total = data.total;
  const share = (row: UsageRow) => sharePercent(row.cost_micros, total.cost_micros);
  const numbers = <Row extends UsageRow>(): Column<Row>[] => [
    { id: "requests", label: "Requests", align: "right", cell: (row) => count(row.requests) },
    { id: "tokens", label: "Total tokens", align: "right", cell: (row) => count(row.total_tokens) },
    { id: "cost", label: "Cost ($)", align: "right", cell: (row) => costText(row.cost_micros) },
  ];
  const shareColumn = <Row extends UsageRow>(): Column<Row> => ({ id: "share", label: "Share of cost", align: "right", cell: (row) => <ShareBar percent={share(row)} /> });
  const serverColumns: Column<ServerUsage>[] = [
    { id: "server", label: "Server", cell: (row) => <span className="flex items-center gap-2"><ServerMark server={{ name: row.name, icon: iconUrl(row.icon) }} />{row.name}</span> },
    ...numbers<ServerUsage>(),
    shareColumn<ServerUsage>(),
  ];
  const modelColumns: Column<ModelUsage>[] = [
    { id: "model", label: "Model", cell: (row) => <code>{row.model}</code> },
    ...numbers<ModelUsage>(),
    shareColumn<ModelUsage>(),
  ];
  return (
    <SettingsGroup title="Total usage" description="Lifetime totals for every server. Total tokens is input (uncached) plus input (cached) plus output. The server and model tables show the top 10 by cost.">
      <Table label="Total usage, all servers" columns={numbers<UsageRow>()} rows={[total]} rowKey={() => "all"} />
      <Table label="Usage by server" columns={serverColumns} rows={data.servers} rowKey={(row) => row.server} empty="No usage yet." />
      <Table label="Usage by model" columns={modelColumns} rows={data.models} rowKey={(row) => row.model} empty="No usage yet." />
    </SettingsGroup>
  );
}

/** A share of the total cost: the percent, then a bar. The width is set through React's style prop. */
function ShareBar({ percent }: { percent: number }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="w-9 text-right">{percent}%</span>
      <span aria-hidden="true" className="block h-1.5 w-24 overflow-hidden rounded-full bg-chat-hover">
        <span className="block h-full rounded-full bg-chat-accent" style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}
