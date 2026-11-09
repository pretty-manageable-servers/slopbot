// The reply box under a channel: the text goes to the channel through the bot (POST /api/conversations/:channel/reply).
import { useMutation } from "@tanstack/react-query";
import { Composer, DictationButton } from "agentic-ui-kit";
import { useState } from "react";
import { ApiError, post } from "../api";
import type { ReplyResult } from "../api-types";
import { useConsoleDictation } from "../ui/dictation";
import { usePausedComposer } from "../llm-status";
import { notify, notifyError } from "../ui/feedback";

export function ReplyBox({ server, channel }: { server: string; channel: string }) {
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: (body: string) => post<ReplyResult>(`/api/conversations/${encodeURIComponent(channel)}/reply`, { server, text: body }),
    onSuccess: (result) => {
      setText("");
      if (result.status === "posted") notify("Sent. Slopbot will answer in the channel.");
      else notify("Sent to Discord, but Slopbot did not pick it up in time, so it will not answer.", "error");
    },
    onError: (error, body) => {
      // The composer empties on send; the text comes back when the field is still empty, as in a private chat.
      setText((current) => current || body);
      // A usage limit's error body has resetAt (see the reply route in src/web-console.ts).
      const resetAt = error instanceof ApiError ? error.data.resetAt : undefined;
      if (typeof resetAt === "number") notify(`Limit reached, resets ${new Date(resetAt).toLocaleString()}.`, "error");
      else notifyError(error);
    },
  });
  const dictation = useConsoleDictation();
  const paused = usePausedComposer();
  return (
    <Composer
      variant="docked"
      placeholder="Reply to the channel…"
      value={text}
      onChange={setText}
      onSubmit={(body) => send.mutate(body)}
      submitDisabled={send.isPending}
      dictation={dictation.state}
      trailing={dictation.supported && <DictationButton onPress={dictation.start} />}
      {...paused}
    />
  );
}
