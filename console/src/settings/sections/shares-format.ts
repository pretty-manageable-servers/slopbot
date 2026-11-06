// Text and links for the Shared links settings, kept out of the component so they can be tested.
import type { ServerShare, SnapshotChannel } from "../../api-types";

/** The public link of a share: the shared chat at /s/<id> on the origin the console is served from. */
export const shareUrl = (origin: string, id: string) => `${origin}/s/${encodeURIComponent(id)}`;

/** A channel as "#name" from the server snapshot, or the channel id when the snapshot does not list it. */
export function channelLabel(id: string, channels: Pick<SnapshotChannel, "id" | "name">[]) {
  const channel = channels.find((c) => c.id === id);
  return channel ? `#${channel.name}` : id;
}

export const shareStatus = (share: Pick<ServerShare, "revoked">) => (share.revoked ? "Revoked" : "Active");

export const activeShares = (shares: ServerShare[]) => shares.filter((share) => !share.revoked);

/** The notice after Revoke all. */
export const revokedNotice = (count: number) => `${count} ${count === 1 ? "link" : "links"} revoked`;
