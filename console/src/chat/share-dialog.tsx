// The Share popover of one private chat, under the header's Share button. A link is a frozen copy of the messages up
// to when it was made, at /s/<id> on this site. Access is "Only you" (no active link) or "Anyone with the link".
// The settings view changes it: Save makes a link and copies it, or removes every active link.
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, IconButton, Modal, Popover, useIcons } from "agentic-ui-kit";
import { DropdownMenu } from "../ui/menu";
import { useState, type ReactNode, type RefObject } from "react";
import { Dialog, Heading } from "react-aria-components";
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
  const onOpenChange = (open: boolean) => { if (!open) onClose(); };
  const panel = chatId !== null && <SharePanel chatId={chatId} onClose={onClose} />;
  if (!triggerRef) return <Modal isOpen={chatId !== null} onOpenChange={onOpenChange} aria-label="Share chat" className="max-w-[30rem]">{panel}</Modal>;
  return (
    <Popover triggerRef={triggerRef} isOpen={chatId !== null} onOpenChange={onOpenChange} placement="bottom end" className="w-[min(30rem,calc(100vw-2rem))]">
      <Dialog aria-label="Share chat" className="outline-none">{panel}</Dialog>
    </Popover>
  );
}

export function SharePanel({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const client = useQueryClient();
  // Always refetch on open, so `newer` is current.
  const { data: shares, error, isPending } = useQuery({ ...sharesQuery(chatId), staleTime: 0, refetchOnMount: "always" });
  const active = (shares ?? []).filter((share) => !share.revoked).sort((a, b) => b.created_at - a.created_at);
  const access: Access = active.length ? "link" : "private";
  // The settings view, with the access it would save.
  const [draft, setDraft] = useState<Access | null>(null);

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
      <div className="flex flex-col gap-4 p-4 text-sm">
        <div className="flex items-center gap-1">
          <IconButton label="Back" variant="ghost" size="sm" onPress={() => setDraft(null)}>{icons.back}</IconButton>
          <Heading slot="title" className="flex-1 text-base font-medium">Share chat settings</Heading>
          <IconButton label="Close" variant="ghost" size="sm" onPress={onClose}>{icons.close}</IconButton>
        </div>
        <AccessPicker value={draft} onChange={setDraft} />
        {draft === "link" ? <LinkNotes /> : access === "link" && (
          <p className="text-chat-muted">Turning off the link stops it working for everyone. Copies people already made stay.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="subtle" size="sm" onPress={() => setDraft(null)}>Back</Button>
          <Button variant="primary" size="sm" isDisabled={draft === access || save.isPending} onPress={() => save.mutate(draft)}>Save</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <div className="flex items-center gap-2">
        <Heading slot="title" className="flex-1 text-base font-medium">Share chat</Heading>
        <IconButton label="Close" variant="ghost" size="sm" onPress={onClose}>{icons.close}</IconButton>
      </div>
      <p className="text-chat-muted">{subtitle(active[0])}</p>
      {active[0] && (
        <Button variant="outline" size="sm" className="self-start" isDisabled={!active[0].newer || refresh.isPending} onPress={() => refresh.mutate(active[0]!.id)}>
          Add new messages
        </Button>
      )}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-chat-muted">Who has access</p>
        <Button variant="ghost" className="w-full justify-start gap-3 px-2 py-2" isDisabled={isPending} onPress={() => setDraft(access)}>
          <span className="grid size-8 place-items-center rounded-full bg-chat-surface">{ACCESS[access].icon}</span>
          <span className="flex-1 text-left">{isPending ? "Loading…" : ACCESS[access].label}</span>
          {icons.forward}
        </Button>
        {error && <p role="alert" className="text-chat-muted">{error.message}</p>}
      </div>
      <p className="text-xs text-chat-muted">{POLICY}</p>
      <div className="flex items-center justify-end gap-2 border-t border-chat-divider pt-4">
        <IconButton label="Share settings" variant="subtle" size="sm" isDisabled={isPending} onPress={() => setDraft(access)}>{icons.settings}</IconButton>
        {/* Without a link, Copy link opens the settings on "Anyone with the link", so the notes show before it goes public. */}
        <Button variant="outline" size="sm" className="gap-2" isDisabled={isPending} onPress={() => (active[0] ? void copyLink(active[0].id) : setDraft("link"))}>
          {icons.link}Copy link
        </Button>
      </div>
    </div>
  );
}

function subtitle(link: ChatShare | undefined): string {
  if (!link) return "Only messages up until now will be shared.";
  return `The link shows the messages up to ${new Date(link.frozen_at).toLocaleString()}. Later messages are not added unless you add them.`;
}

function AccessPicker({ value, onChange }: { value: Access; onChange: (access: Access) => void }) {
  const kit = useIcons();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-chat-muted">Who has access</p>
      <DropdownMenu label="Who has access" width="trigger" sheet={false} selected={value} onSelect={(key) => onChange(key as Access)}
        items={(Object.keys(ACCESS) as Access[]).map((key) => ({ id: key, label: ACCESS[key].label, icon: ACCESS[key].icon }))}
        trigger={
          <Button variant="subtle" className="w-full justify-start gap-2">
            {ACCESS[value].icon}
            <span className="flex-1 text-left">{ACCESS[value].label}</span>
            {kit.dropdown}
          </Button>
        } />
    </div>
  );
}

function LinkNotes() {
  return (
    <div className="rounded-chat-md border border-chat-popover-border">
      {NOTES.map((note) => (
        <div key={note.title} className="flex gap-3 border-b border-chat-divider px-4 py-3">
          <span className="mt-0.5 text-chat-muted">{note.icon}</span>
          <p className="text-chat-muted"><span className="font-medium text-chat-fg">{note.title}</span> {note.text}</p>
        </div>
      ))}
      <p className="px-4 py-3 text-xs text-chat-muted">{POLICY}</p>
    </div>
  );
}
