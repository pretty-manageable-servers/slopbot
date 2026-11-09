// Shared links settings: the share links of the picked server, with copy and revoke, as the old console's list
// (web/shares.js renderShareList). Listing needs Manage Server; without it the bot answers 403 and the section says so.
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Badge, Button } from "agentic-ui-kit";
import { ApiError, get, post, qs } from "../../api";
import type { ServerShare } from "../../api-types";
import { settingsQuery, useServer } from "../../data";
import { confirmAction, notify, notifyError } from "../../ui/feedback";
import { Table, type Column } from "../../ui/controls";
import { SectionNote, SettingsGroup } from "../../ui/layout";
import { activeShares, channelLabel, revokedNotice, shareStatus, shareUrl } from "./shares-format";

/** The server's links, newest 200. Null when the user lacks Manage Server (the bot answers 403). */
const sharesQuery = (server: string) => queryOptions({
  queryKey: ["shares", server],
  queryFn: async () => {
    try {
      return (await get<{ shares: ServerShare[] }>(`/api/shares${qs({ server })}`)).shares;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) return null;
      throw error;
    }
  },
});

export default function Section() {
  const server = useServer();
  const client = useQueryClient();
  const { data: shares } = useSuspenseQuery(sharesQuery(server.id));
  const { data: snapshot } = useSuspenseQuery(settingsQuery(server.id));
  const refresh = () => client.invalidateQueries({ queryKey: ["shares", server.id] });

  const revoke = useMutation({
    mutationFn: (id: string) => post(`/api/shares/${encodeURIComponent(id)}/revoke`),
    onError: notifyError,
    onSettled: refresh,
  });
  const revokeAll = useMutation({
    mutationFn: () => post<{ revoked: number }>("/api/shares/revoke-all", { server: server.id }),
    onSuccess: ({ revoked }) => notify(revokedNotice(revoked)),
    onError: notifyError,
    onSettled: refresh,
  });

  if (shares === null) return <SectionNote>Manage Server permission is required to see share links.</SectionNote>;

  const askRevoke = async (share: ServerShare) => {
    if (await confirmAction({ title: "Revoke this link?", body: "Anyone with the link loses access at once.", confirmLabel: "Revoke", danger: true })) revoke.mutate(share.id);
  };
  const askRevokeAll = async () => {
    if (await confirmAction({ title: "Revoke every share link?", body: "Links in this server stop working at once.", confirmLabel: "Revoke all", danger: true })) revokeAll.mutate();
  };
  const copy = (id: string) => navigator.clipboard.writeText(shareUrl(location.origin, id)).then(() => notify("Link copied"), notifyError);

  const columns: Column<ServerShare>[] = [
    { id: "channel", label: "Channel", cell: (share) => channelLabel(share.channel, snapshot.channels) },
    { id: "created", label: "Created", cell: (share) => new Date(share.created_at).toLocaleString() },
    { id: "status", label: "Status", cell: (share) => <Badge tone={share.revoked ? undefined : "outline"}>{shareStatus(share)}</Badge> },
    { id: "link", label: "Link", cell: (share) => share.revoked
      ? <span className="text-chat-muted">Link removed</span>
      : <Button size="sm" variant="ghost" onPress={() => copy(share.id)}>Copy link</Button> },
    { id: "revoke", label: "Actions", hideLabel: true, align: "right", cell: (share) => share.revoked ? null
      : <Button size="sm" variant="ghost" isDisabled={revoke.isPending} onPress={() => askRevoke(share)}>Revoke</Button> },
  ];

  return (
    <SettingsGroup
      title="Share links"
      actions={activeShares(shares).length ? <Button size="sm" variant="danger" isDisabled={revokeAll.isPending} onPress={askRevokeAll}>Revoke all</Button> : null}
    >
      <Table label="Share links" columns={columns} rows={shares} rowKey={(share) => share.id} empty="No share links yet." />
    </SettingsGroup>
  );
}
