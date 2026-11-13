// Shared links settings: the share links of the picked server, with copy and revoke, as the old console's list
// (web/shares.js renderShareList). Listing needs Manage Server; without it the bot answers 403 and the section says so.
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Badge, Button, DataTable, confirm, SettingsGroup } from "slop-ui-components";
import { ApiError, get, post, qs } from "../../api";
import type { ServerShare } from "../../api-types";
import { settingsQuery, useServer } from "../../data";
import { notify, notifyError } from "../../ui/feedback";
import { SectionNote } from "../../ui/layout";
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
    if (await confirm({ title: "Revoke this link?", description: "Anyone with the link loses access at once.", confirmLabel: "Revoke", destructive: true })) revoke.mutate(share.id);
  };
  const askRevokeAll = async () => {
    if (await confirm({ title: "Revoke every share link?", description: "Links in this server stop working at once.", confirmLabel: "Revoke all", destructive: true })) revokeAll.mutate();
  };
  const copy = (id: string) => navigator.clipboard.writeText(shareUrl(location.origin, id)).then(() => notify("Link copied"), notifyError);

  return (
    <SettingsGroup
      title="Share links"
    >
      <DataTable
        aria-label="Share links"
        rows={shares}
        rowKey={(share) => share.id}
        emptyState="No share links yet."
        columns={[
          { id: "channel", header: "Channel", cell: (share) => channelLabel(share.channel, snapshot.channels) },
          { id: "created", header: "Created", cell: (share) => new Date(share.created_at).toLocaleString(), className: "w-52" },
          { id: "status", header: "Status", className: "w-28", cell: (share) => <Badge>{shareStatus(share)}</Badge> },
          { id: "link", header: "Link", className: "w-32", cell: (share) => share.revoked ? <span className="text-muted">Link removed</span> : <Button size="sm" variant="ghost" onPress={() => copy(share.id)}>Copy link</Button> },
          { id: "actions", header: <span className="sr-only">Actions</span>, align: "end", className: "w-24", cell: (share) => !share.revoked && <Button size="sm" variant="ghost" isDisabled={revoke.isPending} onPress={() => askRevoke(share)}>Revoke</Button> },
        ]}
      />
    {activeShares(shares).length > 0 && <div className="flex justify-end"><Button size="sm" variant="danger" isDisabled={revokeAll.isPending} onPress={askRevokeAll}>Revoke all</Button></div>}
    </SettingsGroup>
  );
}
