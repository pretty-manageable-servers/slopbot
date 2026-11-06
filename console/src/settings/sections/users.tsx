// Users, Slopbot team only: every known user across all servers, with usage, resets, grants and limit overrides.
// Ported from the old console's Manage users (web/app.js renderUsersAdmin and openUser). The list keeps its search
// and page when a user is opened, so the detail's Back button returns to the same page.
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button } from "agentic-ui-kit";
import { useEffect, useState, type ReactNode } from "react";
import { get, post, qs } from "../../api";
import type { MemberProfile, UserDetail, UserLimitOverride, UserRow, UserUsageWindow, UsersPage } from "../../api-types";
import { adminMeQuery } from "../../data";
import { NumberField, Select, Table, TextField, type Column, type Option } from "../../ui/controls";
import { confirmAction, notify, notifyError } from "../../ui/feedback";
import { SectionNote, SettingsGroup, SettingsRow } from "../../ui/layout";
import {
  avatarSrc, hasWindow, limitError, limitText, money, overrideBody, pageText, serverSummary, sharePct, usageText, when, windowOf, type WindowKind,
} from "./users-format";

const PAGE_SIZES = [5, 10, 25, 50];
const DEFAULT_PAGE_SIZE = 10;
const SEARCH_MAX = 100;
const PAGE_OPTIONS: Option<string>[] = PAGE_SIZES.map((size) => ({ id: String(size), label: `${size} per page` }));
const KIND_OPTIONS: Option<WindowKind>[] = [{ id: "5h", label: "5-hour" }, { id: "week", label: "Weekly" }];
const KIND_NAME: Record<WindowKind, string> = { "5h": "5-hour", week: "weekly" };
const WINDOW_LABEL: Record<WindowKind, string> = { "5h": "5-hour window", week: "Weekly window" };
const WINDOW_KINDS: WindowKind[] = ["5h", "week"];
const RESET: Record<WindowKind, { title: string; body: string; done: string }> = {
  "5h": { title: "Reset the 5-hour window?", body: "The spend in the 5-hour window is cleared.", done: "The 5-hour window is reset." },
  week: { title: "Reset the weekly window?", body: "The 5-hour and weekly windows are both cleared.", done: "The 5-hour and weekly windows are reset." },
};

// The list is keyed by its search, page size and offset, so a page the user has seen comes back without a wait.
interface ListState { q: string; limit: number; offset: number }
const usersQuery = (list: ListState) => queryOptions({
  queryKey: ["admin", "users", list.q, list.limit, list.offset],
  queryFn: () => get<UsersPage>(`/api/admin/users${qs({ q: list.q, limit: list.limit, offset: list.offset })}`),
  placeholderData: keepPreviousData,
});
const userQuery = (id: string) => queryOptions({
  queryKey: ["admin", "user", id],
  queryFn: () => get<UserDetail>(`/api/admin/users/one${qs({ user: id })}`),
});

interface Write { path: "reset" | "grant" | "override"; body: object; done: string }
type UserWrite = ReturnType<typeof useUserWrite>;

/** Runs one write. The answer replaces the user's detail, and the list is refreshed the next time it is shown. */
function useUserWrite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: Write) => post<UserDetail>(`/api/admin/users/${path}`, body),
    onSuccess: (view, { done }) => {
      client.setQueryData(userQuery(view.user.id).queryKey, view);
      notify(done);
    },
    onError: notifyError,
    onSettled: () => client.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export default function Section() {
  const { data: team } = useQuery(adminMeQuery);
  const canEdit = team?.canEdit ?? false;
  const [text, setText] = useState("");
  const [list, setList] = useState<ListState>({ q: "", limit: DEFAULT_PAGE_SIZE, offset: 0 });
  const [openId, setOpenId] = useState<string | null>(null);

  // The search waits 300 ms after the last key, and a new search starts at the first page.
  useEffect(() => {
    const timer = setTimeout(() => {
      const q = text.trim();
      setList((current) => (current.q === q ? current : { ...current, q, offset: 0 }));
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);

  if (openId) return <UserPage id={openId} canEdit={canEdit} onBack={() => setOpenId(null)} />;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <TextField label="Find a user" type="search" value={text} onChange={setText} maxLength={SEARCH_MAX} placeholder="Name, @username or ID" className="min-w-0 flex-1" />
        <Select label="Page size" options={PAGE_OPTIONS} value={String(list.limit)} onChange={(value) => setList((current) => ({ ...current, limit: Number(value), offset: 0 }))} />
      </div>
      <SettingsGroup title="Users" description="Limits and usage for each user, across all servers. Read-only members can view everything.">
        <UserTable list={list} onPage={(offset) => setList((current) => ({ ...current, offset }))} onOpen={setOpenId} />
      </SettingsGroup>
    </>
  );
}

const USER_COLUMNS: Column<UserRow>[] = [
  { id: "person", label: "Person", cell: (row) => <Person user={row.user} badge={row.override !== null && <Badge tone="outline">Override</Badge>} /> },
  { id: "servers", label: "Servers", cell: (row) => <ServerNames servers={row.servers} /> },
  { id: "5h", label: "5-hour", cell: (row) => <WindowCell win={windowOf(row, "5h")} /> },
  { id: "week", label: "Weekly", cell: (row) => <WindowCell win={windowOf(row, "week")} /> },
];

function UserTable({ list, onPage, onOpen }: { list: ListState; onPage: (offset: number) => void; onOpen: (id: string) => void }) {
  const query = useQuery(usersQuery(list));
  const page = query.data;
  if (!page) return <SectionNote>{query.error?.message ?? "Loading…"}</SectionNote>;
  const { offset, limit, total } = page;
  return (
    <>
      <div className={query.isPlaceholderData ? "opacity-60 transition-opacity" : ""}>
        <Table label="Users" columns={USER_COLUMNS} rows={page.users} rowKey={(row) => row.user.id} onRowPress={(row) => onOpen(row.user.id)}
          empty={list.q ? "No users match this search." : "No users are known yet."} />
      </div>
      <div className="flex items-center justify-between gap-3 py-3 text-sm">
        <Button variant="ghost" size="sm" isDisabled={offset === 0} onPress={() => onPage(Math.max(0, offset - limit))}>Previous</Button>
        <span className="tabular-nums text-chat-muted">{pageText(offset, page.users.length, total)}</span>
        <Button variant="ghost" size="sm" isDisabled={offset + limit >= total} onPress={() => onPage(offset + limit)}>Next</Button>
      </div>
    </>
  );
}

function Person({ user, badge }: { user: MemberProfile; badge?: ReactNode }) {
  const src = avatarSrc(user.avatarUrl);
  return (
    <span className="flex min-w-0 items-center gap-2.5" title={`ID ${user.id}`}>
      {src
        ? <img src={src} alt="" width={24} height={24} loading="lazy" referrerPolicy="no-referrer" className="size-6 shrink-0 rounded-full" />
        : <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-chat-raised text-xs font-semibold">{user.displayName.trim().charAt(0).toUpperCase() || "?"}</span>}
      <span className="min-w-0">
        <span className="flex items-center gap-2"><span className="truncate">{user.displayName}</span>{badge}</span>
        {user.username && <span className="block truncate text-xs text-chat-muted">@{user.username}</span>}
      </span>
    </span>
  );
}

function ServerNames({ servers }: { servers: { name: string }[] }) {
  if (!servers.length) return <span className="text-chat-muted">Web only</span>;
  const { names, more } = serverSummary(servers);
  return <span className="block max-w-56 truncate">{names.join(", ")}{more > 0 && ` +${more}`}</span>;
}

/** The share of a limit used, as a small bar under the text. */
function Bar({ pct }: { pct: number }) {
  return (
    <div role="progressbar" aria-label="Share of the limit used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1 w-full overflow-hidden rounded-full bg-chat-border">
      <span className="block h-full rounded-full bg-chat-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

function WindowCell({ win }: { win: UserUsageWindow }) {
  if (!hasWindow(win)) return <span className="text-chat-muted">—</span>;
  return (
    <div className="flex min-w-40 flex-col gap-1">
      <span>{usageText(win)}</span>
      {win.limit > 0 && <Bar pct={sharePct(win)} />}
      <span className="text-xs text-chat-muted">Banked {win.banked}</span>
    </div>
  );
}

function UserPage({ id, canEdit, onBack }: { id: string; canEdit: boolean; onBack: () => void }) {
  const query = useQuery(userQuery(id));
  return (
    <div className="flex flex-col gap-6">
      <div><Button variant="ghost" size="sm" onPress={onBack}>Back to users</Button></div>
      {query.data ? <UserBody view={query.data} canEdit={canEdit} /> : <SectionNote>{query.error?.message ?? "Loading…"}</SectionNote>}
    </div>
  );
}

function UserBody({ view, canEdit }: { view: UserDetail; canEdit: boolean }) {
  const write = useUserWrite();
  const reset = async (kind: WindowKind) => {
    const text = RESET[kind];
    if (await confirmAction({ title: text.title, body: text.body, confirmLabel: "Reset", danger: true })) {
      write.mutate({ path: "reset", body: { user: view.user.id, kind }, done: text.done });
    }
  };
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Person user={view.user} />
        <span className="text-sm text-chat-muted">{view.servers.map((server) => server.name).join(", ") || "Web only"}</span>
      </header>
      <SettingsGroup title="Usage" description="A window starts at the first spend and runs for its length. A reset clears it.">
        {WINDOW_KINDS.map((kind) => (
          <WindowRow key={kind} kind={kind} win={windowOf(view, kind)} canEdit={canEdit} busy={write.isPending} onReset={() => void reset(kind)} />
        ))}
      </SettingsGroup>
      {canEdit && <GrantGroup userId={view.user.id} write={write} />}
      <OverrideGroup view={view} canEdit={canEdit} write={write} />
      <SettingsGroup title="Lifetime totals" description="All usage by this user, per server and model.">
        <Table label="Lifetime totals" columns={TOTAL_COLUMNS} rows={view.totals} rowKey={(total) => `${total.server}/${total.model}`} empty="No usage yet." />
      </SettingsGroup>
    </>
  );
}

function WindowRow({ kind, win, canEdit, busy, onReset }: { kind: WindowKind; win: UserUsageWindow; canEdit: boolean; busy: boolean; onReset: () => void }) {
  const clock = win.resetAt === null ? "No window running. It starts at the first spend." : `Resets ${when(win.resetAt)}.`;
  return (
    <SettingsRow label={WINDOW_LABEL[kind]} help={`${clock} Banked resets: ${win.banked}`}>
      <div className="flex w-56 flex-col gap-1 text-sm">
        <span>{usageText(win)}</span>
        {win.limit > 0 && <Bar pct={sharePct(win)} />}
      </div>
      {canEdit && <Button variant="outline" size="sm" isDisabled={busy} onPress={onReset}>Reset now</Button>}
    </SettingsRow>
  );
}

function GrantGroup({ userId, write }: { userId: string; write: UserWrite }) {
  const [kind, setKind] = useState<WindowKind>("5h");
  const [count, setCount] = useState(1);
  const valid = Number.isInteger(count) && count >= 1 && count <= 100;
  return (
    <SettingsGroup title="Grant resets" description="A grant adds banked resets the user can use later.">
      <SettingsRow label="Kind and count" help="From 1 to 100 at a time.">
        <Select label="Reset kind" options={KIND_OPTIONS} value={kind} onChange={setKind} />
        <NumberField label="Count" value={count} onChange={setCount} min={1} max={100} className="w-20" />
        <Button variant="outline" size="sm" isDisabled={!valid || write.isPending}
          onPress={() => write.mutate({ path: "grant", body: { user: userId, kind, count }, done: `Granted ${count} ${KIND_NAME[kind]} ${count === 1 ? "reset" : "resets"}.` })}>
          Grant
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}

const limitShown = (micros: number | null | undefined) => (micros == null ? "Global limit" : money(micros));

function OverrideGroup({ view, canEdit, write }: { view: UserDetail; canEdit: boolean; write: UserWrite }) {
  const override = view.override;
  const status = override ? "This user has an override." : "This user uses the global limit.";
  return (
    <SettingsGroup title="Limit override" description={`${status} It replaces the global limit in all servers. Zero means no limit.`}>
      {canEdit
        ? <OverrideForm key={JSON.stringify(override)} userId={view.user.id} override={override} write={write} />
        : (
          <>
            <SettingsRow label="5-hour limit"><span className="text-sm">{limitShown(override?.five_hour_cost_micros)}</span></SettingsRow>
            <SettingsRow label="Weekly limit"><span className="text-sm">{limitShown(override?.week_cost_micros)}</span></SettingsRow>
          </>
        )}
    </SettingsGroup>
  );
}

/** The two limit fields. A blank field is the global limit. Remounted (by key) when the saved override changes. */
function OverrideForm({ userId, override, write }: { userId: string; override: UserLimitOverride | null; write: UserWrite }) {
  const [five, setFive] = useState(limitText(override?.five_hour_cost_micros ?? null));
  const [week, setWeek] = useState(limitText(override?.week_cost_micros ?? null));
  const fiveError = limitError(five);
  const weekError = limitError(week);
  const save = () => {
    const body = overrideBody(userId, five, week);
    const cleared = body.five_hour_cost_micros === null && body.week_cost_micros === null;
    write.mutate({ path: "override", body, done: cleared ? "The override is cleared. The global limit applies." : "The override is saved." });
  };
  const remove = async () => {
    const ok = await confirmAction({ title: "Remove this override?", body: "The user goes back to the global limits in all servers.", confirmLabel: "Remove", danger: true });
    if (ok) write.mutate({ path: "override", body: overrideBody(userId, "", ""), done: "The override is cleared. The global limit applies." });
  };
  return (
    <>
      <SettingsRow label="5-hour limit in dollars" help={fiveError && <span className="text-chat-danger">{fiveError}</span>}>
        <TextField label="5-hour limit in dollars" type="number" value={five} onChange={setFive} placeholder="Global limit" className="w-36" />
      </SettingsRow>
      <SettingsRow label="Weekly limit in dollars" help={weekError && <span className="text-chat-danger">{weekError}</span>}>
        <TextField label="Weekly limit in dollars" type="number" value={week} onChange={setWeek} placeholder="Global limit" className="w-36" />
      </SettingsRow>
      <div className="flex justify-end gap-2 py-3">
        {override && <Button variant="outline" size="sm" isDisabled={write.isPending} onPress={() => void remove()}>Remove override</Button>}
        <Button variant="primary" size="sm" isDisabled={fiveError !== null || weekError !== null || write.isPending} onPress={save}>Save override</Button>
      </div>
    </>
  );
}

const TOTAL_COLUMNS: Column<UserDetail["totals"][number]>[] = [
  { id: "server", label: "Server", cell: (total) => total.serverName },
  { id: "model", label: "Model", cell: (total) => <code className="text-xs">{total.model}</code> },
  { id: "requests", label: "Requests", align: "right", cell: (total) => total.requests.toLocaleString() },
  { id: "input", label: "Input (uncached)", align: "right", cell: (total) => total.input.toLocaleString() },
  { id: "cached", label: "Input (cached)", align: "right", cell: (total) => total.cached.toLocaleString() },
  { id: "output", label: "Output", align: "right", cell: (total) => total.output.toLocaleString() },
  { id: "cost", label: "Cost", align: "right", cell: (total) => money(total.costMicros) },
  { id: "first", label: "First use", cell: (total) => when(total.firstAt) },
  { id: "last", label: "Last use", cell: (total) => when(total.lastAt) },
];
