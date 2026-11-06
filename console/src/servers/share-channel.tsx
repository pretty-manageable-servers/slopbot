// The share link of one channel, in a kit Modal. A link is a frozen copy of the channel's newest messages (up to 200)
// at /s/<id> on this site. "Create link" makes one (POST /api/shares, src/web-console.ts) and copies it.
import { useMutation } from "@tanstack/react-query";
import { Button, Modal } from "agentic-ui-kit";
import { useState } from "react";
import { post } from "../api";
import type { CreateShareBody } from "../api-types";
import { notify, notifyError } from "../ui/feedback";

/** Opens while `open` is set. Closing it calls `onClose`. */
export function ShareChannelDialog({ server, channel, open, onClose }: { server: string; channel: string; open: boolean; onClose: () => void }) {
  const [thinking, setThinking] = useState(true);
  const create = useMutation({
    mutationFn: () => post<{ id: string }>("/api/shares", { server, channel, show_thinking: thinking } satisfies CreateShareBody),
    onSuccess: ({ id }) => {
      void navigator.clipboard.writeText(`${location.origin}/s/${id}`).then(() => notify("Link copied"), notifyError);
      onClose();
    },
    onError: notifyError,
  });

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Share this conversation" className="max-w-md">
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-chat-muted">Shares the newest messages in this channel (up to 200). The copy is frozen; later messages are not added. Search engines do not list the link.</p>
        <label className="flex items-center gap-2 font-chat-sans text-(length:--chat-ui-font-size)">
          <input type="checkbox" className="accent-(--chat-accent)" checked={thinking} onChange={(e) => setThinking(e.target.checked)} />
          Include Slopbot reasoning and tool activity
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onPress={onClose}>Close</Button>
          <Button variant="primary" isDisabled={create.isPending} onPress={() => create.mutate()}>Create link</Button>
        </div>
      </div>
    </Modal>
  );
}
