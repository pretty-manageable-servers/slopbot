// Servers (Slopbot team only): every server the bot is in. A server opens to its web transcripts per channel, the
// cloud-model switch and the webhook rotation. Everyone on the team sees it; without canEdit the writes are disabled.
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "agentic-ui-kit";
import { useEffect, useState } from "react";
import { ApiError, get, post, qs } from "../../api";
import type { AdminServer, NonZdr, TranscriptChannel } from "../../api-types";
import { adminMeQuery } from "../../data";
import { type Column, Switch, Table, TextField } from "../../ui/controls";
import { confirmAction, notify, notifyError } from "../../ui/feedback";
import { SectionNote, ServerMark, SettingsGroup, SettingsRow } from "../../ui/layout";
import { SERVER_PAGE, pageLabel } from "./servers-format";

interface ServerPage { servers: AdminServer[]; total: number }
interface ServerChannels { server: string; name: string; channels: TranscriptChannel[] }

const serversQuery = (q: string, offset: number) => queryOptions({
  queryKey: ["admin", "servers", q, offset],
  queryFn: () => get<ServerPage>(`/api/admin/servers${qs({ q, offset, limit: SERVER_PAGE })}`),
  placeholderData: keepPreviousData,
});
const channelsQuery = (server: string) => queryOptions({
  queryKey: ["admin", "server", server, "channels"],
  queryFn: () => get<ServerChannels>(`/api/admin/servers/channels${qs({ server })}`),
});
const nonZdrQuery = (server: string) => queryOptions({
  queryKey: ["admin", "server", server, "non-zdr"],
  queryFn: () => get<NonZdr>(`/api/admin/servers/non-zdr${qs({ server })}`),
});

/** The value once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

// The search and the page live here, so going back from a server keeps them.
export default function Section() {
  const { data: me } = useQuery(adminMeQuery);
  const canEdit = me?.canEdit ?? false;
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [server, setServer] = useState<AdminServer | null>(null);
  if (server) return <ServerDetail server={server} canEdit={canEdit} onBack={() => setServer(null)} />;
  return (
    <ServerList
      search={search}
      onSearch={(text) => { setSearch(text); setOffset(0); }}
      offset={offset}
      onOffset={setOffset}
      onOpen={setServer}
    />
  );
}

const SERVER_COLUMNS: Column<AdminServer>[] = [
  { id: "server", label: "Server", cell: (s) => <span className="flex min-w-0 items-center gap-2.5"><ServerMark server={s} /><span className="truncate">{s.name}</span></span> },
  { id: "channels", label: "Channels", align: "right", cell: (s) => s.channelCount },
  { id: "transcripts", label: "Transcripts on", align: "right", cell: (s) => s.transcriptsOn },
];

function ServerList({ search, onSearch, offset, onOffset, onOpen }: {
  search: string; onSearch: (text: string) => void; offset: number; onOffset: (offset: number) => void; onOpen: (server: AdminServer) => void;
}) {
  const q = useDebounced(search.trim(), 300);
  const { data, error } = useQuery(serversQuery(q, offset));
  const total = data?.total ?? 0;
  return (
    <SettingsGroup title="Servers" description="Web transcripts for each server. Read-only members can view everything.">
      <TextField label="Find a server" type="search" value={search} onChange={onSearch} placeholder="Server name" maxLength={100} autoComplete="off" className="mb-2" />
      {error ? <SectionNote>{error.message}</SectionNote> : !data ? <SectionNote>Loading…</SectionNote> : (
        <Table label="Servers" columns={SERVER_COLUMNS} rows={data.servers} rowKey={(s) => s.id} onRowPress={onOpen} empty="No servers match." />
      )}
      <div className="flex items-center justify-between gap-3 py-3 text-sm">
        <span className="text-chat-muted tabular-nums">{pageLabel(offset, data?.servers.length ?? 0, total)}</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" isDisabled={offset === 0} onPress={() => onOffset(offset - SERVER_PAGE)}>Previous</Button>
          <Button variant="outline" size="sm" isDisabled={offset + SERVER_PAGE >= total} onPress={() => onOffset(offset + SERVER_PAGE)}>Next</Button>
        </div>
      </div>
    </SettingsGroup>
  );
}

const NON_ZDR_HELP = "When Slopbot's models are down, channel replies in this server can use cloud models. Those do not keep zero data retention. Only users who opted in get these replies.";

function ServerDetail({ server, canEdit, onBack }: { server: AdminServer; canEdit: boolean; onBack: () => void }) {
  const client = useQueryClient();
  const channelsOptions = channelsQuery(server.id);
  const nonZdrOptions = nonZdrQuery(server.id);
  const channels = useQuery(channelsOptions);
  const nonZdr = useQuery(nonZdrOptions);

  // The old console left the switch off and quiet when the server has no cloud-model setting (a 404).
  useEffect(() => {
    if (nonZdr.error && !(nonZdr.error instanceof ApiError && nonZdr.error.status === 404)) notifyError(nonZdr.error);
  }, [nonZdr.error]);

  const setNonZdr = useMutation({
    mutationFn: (allow: boolean) => post<NonZdr>("/api/admin/servers/non-zdr", { server: server.id, allow }),
    onSuccess: (result) => {
      client.setQueryData(nonZdrOptions.queryKey, result);
      notify(result.allow ? "Cloud models are allowed in this server when ours are down." : "Cloud models are off in this server.");
    },
    onError: notifyError,
  });

  const setTranscripts = useMutation({
    mutationFn: ({ channel, enabled }: { channel: TranscriptChannel; enabled: boolean }) =>
      post<{ channel: string; enabled: boolean }>("/api/admin/transcripts", { server: server.id, channel: channel.id, enabled }),
    onSuccess: ({ channel, enabled }) => {
      client.setQueryData<ServerChannels>(channelsOptions.queryKey, (data) => data && {
        ...data,
        channels: data.channels.map((c) => (c.id === channel ? { ...c, enabled } : c)),
      });
      void client.invalidateQueries({ queryKey: ["admin", "servers"] });
      notify(`Web transcripts ${enabled ? "on" : "off"} for this channel.`);
    },
    onError: notifyError,
  });

  const rotate = useMutation({
    mutationFn: (channel: TranscriptChannel) => post<{ webhookId: string }>("/api/admin/web-webhooks/rotate", { server: server.id, channel: channel.id }),
    onSuccess: (_, channel) => notify(`Web webhook rotated for #${channel.name}.`),
    onError: notifyError,
  });
  const askRotate = async (channel: TranscriptChannel) => {
    const ok = await confirmAction({ title: "Make a new web webhook?", body: `The old webhook for #${channel.name} stops working at once.`, confirmLabel: "Make new webhook", danger: true });
    if (ok) rotate.mutate(channel);
  };

  const columns: Column<TranscriptChannel>[] = [
    { id: "channel", label: "Channel", cell: (c) => `#${c.name}` },
    { id: "transcripts", label: "Web transcripts", cell: (c) => {
      const saving = setTranscripts.isPending && setTranscripts.variables?.channel.id === c.id;
      return (
        <span className="flex items-center gap-2.5">
          <Switch label={`Web transcripts for #${c.name}`} checked={c.enabled} disabled={!canEdit || saving} onChange={(enabled) => setTranscripts.mutate({ channel: c, enabled })} />
          <span className="text-chat-muted">{c.enabled ? "On" : "Off"}</span>
        </span>
      );
    } },
    { id: "webhook", label: "Webhook", align: "right", cell: (c) => (
      <Button variant="outline" size="sm" isDisabled={!canEdit || (rotate.isPending && rotate.variables?.id === c.id)} onPress={() => void askRotate(c)}>Rotate webhook</Button>
    ) },
  ];

  return (
    <>
      <Button variant="ghost" size="sm" className="-ml-2 mb-3" onPress={onBack}>Back to servers</Button>
      <div className="mb-6 flex items-center gap-3">
        <ServerMark server={server} size={28} />
        <h3 className="m-0 min-w-0 truncate text-base font-semibold">{server.name}</h3>
      </div>
      <SettingsGroup title="Cloud models" description="This server only">
        <SettingsRow label="Allow cloud models in channels" help={NON_ZDR_HELP}>
          <Switch label="Allow cloud models in channels" checked={nonZdr.data?.allow ?? false} disabled={!canEdit || !nonZdr.data || setNonZdr.isPending} onChange={(allow) => setNonZdr.mutate(allow)} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Web transcripts" description="Per channel. Off by default. Discord permissions still decide who can see a transcript.">
        {channels.error ? <SectionNote>{channels.error.message}</SectionNote> : !channels.data ? <SectionNote>Loading…</SectionNote> : (
          <Table label="Channels" columns={columns} rows={channels.data.channels} rowKey={(c) => c.id} empty="Slopbot serves no channels in this server yet." />
        )}
      </SettingsGroup>
    </>
  );
}
