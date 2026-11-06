// The usage meter in the composer: a ring that fills to the larger window's percent. Its popover lists each window
// with its reset time and the banked resets that can be used now. It loads with the server and again after each reply.
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Popover } from "agentic-ui-kit";
import { useEffect, useRef } from "react";
import { Dialog, DialogTrigger } from "react-aria-components";
import { api } from "../api";
import { confirmAction, notify, notifyError } from "../ui/feedback";

const usageQuery = (server: string) => queryOptions({ queryKey: ["usage", server], queryFn: () => api.usage(server) });

/** Accent below 50%, warning from 50%, danger from 80%. */
function usageLevel(percent: number): "accent" | "warning" | "danger" {
  return percent >= 80 ? "danger" : percent >= 50 ? "warning" : "accent";
}
const ringColor = { accent: "text-chat-accent", warning: "text-chat-warning", danger: "text-chat-danger" };
const barColor = { accent: "bg-chat-accent", warning: "bg-chat-warning", danger: "bg-chat-danger" };

/** Reset time with two units: "Resets in 3d 4h" over a day, else "Resets in 2h 15m". */
function resetsLabel(resetAt: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((resetAt - now) / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  return `Resets in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${rest}m`}`;
}

export function UsageMeter({ server, busy }: { server: string; busy: boolean }) {
  const client = useQueryClient();
  const { data: usage, isError } = useQuery(usageQuery(server));
  const reset = useMutation({
    mutationFn: (kind: string) => api.useReset(server, kind),
    onSuccess: (next) => {
      client.setQueryData(usageQuery(server).queryKey, next);
      notify("Your usage is reset.");
    },
    onError: notifyError,
  });

  // A reply that just ended has changed the usage.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) void client.invalidateQueries({ queryKey: usageQuery(server).queryKey });
    wasBusy.current = busy;
  }, [busy]);

  const windows = usage?.windows ?? [];
  const most = Math.max(0, ...windows.map((w) => w.percent ?? 0));

  const askReset = async (kind: string) => {
    const fiveHour = kind === "5h";
    const ok = await confirmAction({
      title: "Use a reset?",
      body: fiveHour ? "Your 5-hour usage goes back to 0%." : "Your 5-hour and weekly usage go back to 0%.",
      confirmLabel: "Use reset",
    });
    if (ok) reset.mutate(kind);
  };

  return (
    <DialogTrigger>
      <Button variant="ghost" size="sm" aria-label="Usage" className="size-8 justify-center rounded-chat-sm p-0 text-chat-muted">
        <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" className="-rotate-90">
          <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2.5} />
          <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"
            pathLength={100} strokeDasharray={`${most} 100`} className={ringColor[usageLevel(most)]} />
        </svg>
      </Button>
      <Popover placement="top start">
        <Dialog aria-label="Usage" className="flex w-64 flex-col gap-3 rounded-chat-popover border border-chat-popover-border bg-chat-popover p-3 text-sm text-chat-fg outline-none">
          {usage && <p className="text-chat-muted">Plan: {usage.plan}</p>}
          {isError && <p className="text-chat-muted">Usage is not available right now.</p>}
          {!usage && !isError && <p className="text-chat-muted">Loading…</p>}
          {windows.map((w) => {
            const title = w.kind === "5h" ? "5-hour limit" : "Weekly limit";
            return (
              <div key={w.kind} className="flex flex-col gap-1.5">
                <p>{w.percent === null ? `${title}: No limit` : `${title}: ${w.percent}% used`}</p>
                {w.percent !== null && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-chat-border">
                    <div className={`h-full ${barColor[usageLevel(w.percent)]}`} style={{ width: `${w.percent}%` }} />
                  </div>
                )}
                {w.resetAt !== null && <p className="text-xs text-chat-muted">{resetsLabel(w.resetAt)}</p>}
                {w.banked > 0 && (
                  <Button variant="outline" size="sm" className="self-start" isDisabled={reset.isPending} onPress={() => void askReset(w.kind)}>
                    Use a reset ({w.banked})
                  </Button>
                )}
              </div>
            );
          })}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
