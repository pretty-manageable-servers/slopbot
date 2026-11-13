// The share link of one channel, in a Modal. A link is a frozen copy of the channel's newest messages (up to 200)
// at /s/<id> on this site. "Create link" makes one (POST /api/shares, src/web-console.ts) and copies it.
import { useMutation } from "@tanstack/react-query";
import { Button, Checkbox, Modal } from "slop-ui-components";
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
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Share this conversation" description="Shares the newest messages in this channel (up to 200). The copy is frozen; later messages are not added. Search engines do not list the link." size="md"
      footer={
        <>
          <Button variant="outline" onPress={onClose}>Close</Button>
          <Button variant="primary" isDisabled={create.isPending} onPress={() => create.mutate()}>Create link</Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        <Checkbox isSelected={thinking} onChange={setThinking}>Include Slopbot reasoning and tool activity</Checkbox>
      </div>
    </Modal>
  );
}
