// The share links of one private chat, in a kit Modal. A link is a frozen copy of the messages up to now, at /s/<id>
// on this site. "Create link" makes one and copies it. Each link can be copied or removed.
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal } from "agentic-ui-kit";
import { api } from "../api";
import { confirmAction, notify, notifyError } from "../ui/feedback";

const sharesQuery = (chatId: string) => queryOptions({ queryKey: ["shares", chatId], queryFn: () => api.shares(chatId).then((r) => r.shares) });
const linkOf = (shareId: string) => `${location.origin}/s/${shareId}`;
const copyLink = (shareId: string) => navigator.clipboard.writeText(linkOf(shareId)).then(() => notify("Link copied"), notifyError);

/** Opens while `chatId` is set. Closing it calls `onClose`. */
export function ShareDialog({ chatId, onClose }: { chatId: string | null; onClose: () => void }) {
  return (
    <Modal isOpen={chatId !== null} onOpenChange={(open) => { if (!open) onClose(); }} title="Share this chat" className="max-w-md">
      {chatId !== null && <ShareLinks chatId={chatId} />}
    </Modal>
  );
}

function ShareLinks({ chatId }: { chatId: string }) {
  const client = useQueryClient();
  const { data: shares, error, isPending } = useQuery(sharesQuery(chatId));
  const refresh = () => void client.invalidateQueries({ queryKey: sharesQuery(chatId).queryKey });

  const create = useMutation({
    mutationFn: () => api.createShare(chatId),
    onSuccess: ({ id }) => {
      refresh();
      return copyLink(id);
    },
    onError: notifyError,
  });
  const revoke = useMutation({
    mutationFn: (shareId: string) => api.revokeShare(chatId, shareId),
    onSuccess: () => {
      notify("Link removed.");
      refresh();
    },
    onError: notifyError,
  });
  const remove = async (shareId: string) => {
    const ok = await confirmAction({ title: "Remove this link?", body: "Anyone with it can no longer read this copy.", confirmLabel: "Remove link", danger: true });
    if (ok) revoke.mutate(shareId);
  };

  const active = (shares ?? []).filter((share) => !share.revoked);
  const status = isPending ? "Loading links…" : error ? error.message : active.length ? "" : "No links yet.";

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-chat-muted">Anyone with a link can read a frozen copy of the messages up to now. Later messages are not added. Search engines do not list the link.</p>
      <p role="status" className="text-chat-muted">{status}</p>
      {active.map((share) => (
        <div key={share.id} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-chat-fg">{linkOf(share.id)}</p>
            <p className="text-xs text-chat-muted">Active · Created {new Date(share.created_at).toLocaleString()}</p>
          </div>
          <Button variant="outline" size="sm" onPress={() => void copyLink(share.id)}>Copy link</Button>
          <Button variant="outline" size="sm" isDisabled={revoke.isPending} onPress={() => void remove(share.id)}>Revoke</Button>
        </div>
      ))}
      <div className="flex justify-end">
        <Button variant="primary" isDisabled={create.isPending} onPress={() => create.mutate()}>Create link</Button>
      </div>
    </div>
  );
}
