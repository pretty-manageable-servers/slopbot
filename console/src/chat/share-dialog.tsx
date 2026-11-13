// The Share popover of one private chat, under the header's Share button. A link is a frozen copy of the messages up
// to when it was made, at /s/<id> on this site. Access is "Only you" (no active link) or "Anyone with the link".
// The settings view changes it: Save makes a link and copies it, or removes every active link.
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode, type RefObject } from "react";
import { Alert, Button, IconButton, Modal, Popover, RadioCards, Tooltip } from "slop-ui-components";
import { api } from "../api";
import type { ChatShare } from "../api-types";
import { icons } from "../ui/icons";
import { notify, notifyError } from "../ui/feedback";

type Access = "private" | "link";

const sharesQuery = (chatId: string) => queryOptions({ queryKey: ["shares", chatId], queryFn: () => api.shares(chatId).then((r) => r.shares) });
const linkOf = (shareId: string) => `${location.origin}/s/${shareId}`;
const copyLink = (shareId: string) => navigator.clipboard.writeText(linkOf(shareId)).then(() => notify("Link copied"), notifyError);

const ACCESS: Record<Access, { label: string; icon: ReactNode }> = {
  private: { label: "Only you", icon: icons.lock },
  link: { label: "Anyone with the link", icon: icons.globe },
};

const NOTES: { icon: ReactNode; title: string; text: string }[] = [
  { icon: icons.alert, title: "No sign-in needed.", text: "Anyone who gets the link can open it, and you won't see who did." },
  { icon: icons.link, title: "Links travel.", text: "People can forward it, copy the text, or save it elsewhere. Turning off the link later stops the link but can't take back copies." },
  { icon: icons.search, title: "Not listed, not invisible.", text: "We ask search engines not to index it; archive sites and reposts are outside our control." },
];

const POLICY = "Don't share personal information or someone else's content without permission.";

/**
 * Open while `chatId` is set. With `triggerRef` it floats under that button, else (a sidebar row) it opens as a
 * dialog. Closing it calls `onClose`.
 */
export function ShareDialog({ chatId, triggerRef, onClose }: { chatId: string | null; triggerRef?: RefObject<HTMLElement | null>; onClose: () => void }) {
  // The settings view, with the access it would save.
  const [draft, setDraft] = useState<Access | null>(null);
  const onOpenChange = (open: boolean) => { if (!open) { setDraft(null); onClose(); } };
  const title = draft ? "Share chat settings" : "Share chat";
  const panel = chatId !== null && <SharePanel chatId={chatId} draft={draft} setDraft={setDraft} />;
  if (!triggerRef) return <Modal isOpen={chatId !== null} onOpenChange={onOpenChange} title={title}>{panel}</Modal>;
  return <Popover triggerRef={triggerRef} isOpen={chatId !== null} onOpenChange={onOpenChange} title={title} className="w-96">{panel}</Popover>;
}

/** The body of the share dialog: who has access, the link, and the settings view. */
export function SharePanel({ chatId, draft, setDraft }: { chatId: string; draft: Access | null; setDraft: (access: Access | null) => void }) {
  const client = useQueryClient();
  // Always refetch on open, so `newer` is current.
  const { data: shares, error, isPending } = useQuery({ ...sharesQuery(chatId), staleTime: 0, refetchOnMount: "always" });
  const active = (shares ?? []).filter((share) => !share.revoked).sort((a, b) => b.created_at - a.created_at);
  const access: Access = active.length ? "link" : "private";

  const save = useMutation({
    mutationFn: async (next: Access) => {
      if (next === "link") return (await api.createShare(chatId)).id;
      for (const share of active) await api.revokeShare(chatId, share.id);
      return null;
    },
    onSuccess: async (id) => {
      await client.invalidateQueries({ queryKey: sharesQuery(chatId).queryKey });
      setDraft(null);
      if (id) await copyLink(id);
      else notify("Link turned off.");
    },
    onError: notifyError,
  });

  const refresh = useMutation({
    mutationFn: (shareId: string) => api.refreshShare(chatId, shareId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: sharesQuery(chatId).queryKey });
      notify("Link updated");
    },
    onError: notifyError,
  });

  if (draft) {
    return (
      <div className="flex flex-col gap-4">
        <RadioCards aria-label="Who has access" label="Who has access" columns={1} value={draft} onChange={(next) => setDraft(next as Access)}
          options={(Object.keys(ACCESS) as Access[]).map((key) => ({ id: key, title: ACCESS[key].label, icon: ACCESS[key].icon }))} />
        {draft === "link" ? <LinkNotes /> : access === "link" && (
          <p className="text-ui-sm text-muted">Turning off the link stops it working for everyone. Copies people already made stay.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onPress={() => setDraft(null)}>Back</Button>
          <Button variant="primary" size="sm" isDisabled={draft === access || save.isPending} onPress={() => save.mutate(draft)}>Save</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ui-sm text-muted">{subtitle(active[0])}</p>
      {active[0] && (
        <Button variant="outline" size="sm" className="self-start" isDisabled={!active[0].newer || refresh.isPending} onPress={() => refresh.mutate(active[0]!.id)}>
          Add new messages
        </Button>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-ui-sm font-medium text-muted">Who has access</p>
        <Button variant="ghost" className="w-full justify-start gap-3 px-1.5" isDisabled={isPending} onPress={() => setDraft(access)}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-button text-button-fg [&_svg]:size-icon">{ACCESS[access].icon}</span>
          <span className="flex-1 text-left">{isPending ? "Loading…" : ACCESS[access].label}</span>
          {icons.forward}
        </Button>
        {error && <Alert tone="danger">{error.message}</Alert>}
      </div>
      <p className="text-ui-sm text-muted">{POLICY}</p>
      <hr className="border-divider" />
      <div className="flex items-center justify-end gap-2">
        <Tooltip content="Share settings">
          <IconButton aria-label="Share settings" isDisabled={isPending} onPress={() => setDraft(access)}>{icons.settings}</IconButton>
        </Tooltip>
        {/* Without a link, Copy link opens the settings on "Anyone with the link", so the notes show before it goes public. */}
        <Button icon={icons.link} isDisabled={isPending} onPress={() => (active[0] ? void copyLink(active[0].id) : setDraft("link"))}>Copy link</Button>
      </div>
    </div>
  );
}

function subtitle(link: ChatShare | undefined): string {
  if (!link) return "Only messages up until now will be shared.";
  return `The link shows the messages up to ${new Date(link.frozen_at).toLocaleString()}. Later messages are not added unless you add them.`;
}

function LinkNotes() {
  return (
    <div className="rounded-md border border-border">
      {NOTES.map((note) => (
        <div key={note.title} className="flex gap-3 border-b border-divider px-3 py-2.5">
          <span className="mt-0.5 text-muted [&_svg]:size-icon">{note.icon}</span>
          <p className="text-ui-sm text-muted"><span className="font-medium text-fg">{note.title}</span> {note.text}</p>
        </div>
      ))}
      <p className="px-3 py-2.5 text-ui-sm text-muted">{POLICY}</p>
    </div>
  );
}
