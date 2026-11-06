// The reply box under a channel: the text goes to the channel through the bot (POST /api/conversations/:channel/reply).
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Composer } from "agentic-ui-kit";
import { useState } from "react";
import type { ReplyResult } from "../api-types";
import { sessionQuery } from "../data";
import { notify, notifyError } from "../ui/feedback";

/** A failed reply. resetAt is set for a usage limit (see the reply route in src/web-console.ts). */
class ReplyError extends Error {
  constructor(message: string, readonly resetAt?: number) { super(message); }
}

// api.ts's post() keeps only the error text, and the limit's resetAt is in the body. So this call reads the body
// itself, with the session's CSRF token.
async function sendReply(csrf: string, server: string, channel: string, text: string): Promise<ReplyResult> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(channel)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ server, text }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ReplyError(typeof data.error === "string" ? data.error : `Reply failed (${response.status}).`, typeof data.resetAt === "number" ? data.resetAt : undefined);
  return data as ReplyResult;
}

export function ReplyBox({ server, channel }: { server: string; channel: string }) {
  const { data: session } = useSuspenseQuery(sessionQuery);
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: (body: string) => sendReply(session.csrf, server, channel, body),
    onSuccess: (result) => {
      setText("");
      if (result.status === "posted") notify("Sent. Slopbot will answer in the channel.");
      else notify("Sent to Discord, but Slopbot did not pick it up in time, so it will not answer.", "error");
    },
    onError: (error) => {
      if (error instanceof ReplyError && error.resetAt !== undefined) notify(`Limit reached, resets ${new Date(error.resetAt).toLocaleString()}.`, "error");
      else notifyError(error);
    },
  });
  return (
    <Composer
      variant="docked"
      placeholder="Reply to the channel…"
      value={text}
      onChange={setText}
      onSubmit={(body) => send.mutate(body)}
      submitDisabled={send.isPending}
    />
  );
}
