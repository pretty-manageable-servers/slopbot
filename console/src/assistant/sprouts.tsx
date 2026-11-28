// Sprouts: Bud's goals as tasks. A proposal waits for Approve or Decline; an active sprout can be paused or cancelled;
// a paused one can be resumed. The goal opens the sprout's page (sprout-page.tsx).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge, Button, confirm } from "slop-ui-components";
import { api } from "../api";
import type { AssistantTask } from "../api-types";
import { notifyError } from "../ui/feedback";
import { ago } from "../ui/time";
import { assistantKey } from "./queries";
import { PAUSE_LABEL, STATUS_LABEL, STATUS_ORDER, STATUS_TONE, wakeText } from "./format";

type Action = "approve" | "decline" | "pause" | "resume" | "cancel";
const ACTIONS: Record<AssistantTask["status"], { action: Action; label: string; variant: "primary" | "outline" | "ghost" }[]> = {
  proposed: [{ action: "approve", label: "Approve", variant: "primary" }, { action: "decline", label: "Decline", variant: "outline" }],
  active: [{ action: "pause", label: "Pause", variant: "outline" }, { action: "cancel", label: "Cancel", variant: "ghost" }],
  paused: [{ action: "resume", label: "Resume", variant: "outline" }, { action: "cancel", label: "Cancel", variant: "ghost" }],
  done: [],
  cancelled: [],
  declined: [],
};

/** The sprouts, waiting ones first. */
export function Sprouts({ tasks }: { tasks: AssistantTask[] }) {
  if (tasks.length === 0) return <p className="m-0 text-ui-sm text-muted">No sprouts yet.</p>;
  const sorted = [...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-divider rounded-lg border border-border p-0">
      {sorted.map((task) => <li key={task.id}><SproutRow task={task} /></li>)}
    </ul>
  );
}

/** The buttons that move a sprout on: Approve or Decline, Pause or Cancel, Resume or Cancel. The sprout's page uses them too. */
export function SproutActions({ task }: { task: AssistantTask }) {
  const client = useQueryClient();
  const act = useMutation({
    mutationFn: (action: Action) => api.sproutAction(task.id, action),
    onSuccess: () => void client.invalidateQueries({ queryKey: assistantKey }),
    onError: notifyError,
  });
  // Cancelling a sprout ends it for good, so it asks first.
  const press = async (action: Action) => {
    if (action === "cancel" && !await confirm({ title: "Cancel this sprout?", description: "Bud stops working on it. This cannot be undone.", confirmLabel: "Cancel sprout", destructive: true })) return;
    act.mutate(action);
  };
  if (ACTIONS[task.status].length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {ACTIONS[task.status].map(({ action, label, variant }) => (
        <Button key={action} variant={variant} size="sm" isDisabled={act.isPending} onPress={() => void press(action)}>{label}</Button>
      ))}
    </div>
  );
}

function SproutRow({ task }: { task: AssistantTask }) {
  return (
    <div className="flex flex-col gap-2 p-3">
      <Link to="/assistant/task/$taskId" params={{ taskId: task.id }} className="text-ui font-medium text-fg no-underline hover:underline">{task.goal}</Link>
      <div className="flex flex-wrap items-center gap-2 text-ui-sm">
        <Badge tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Badge>
        {task.status === "paused" && task.pause && <span className="text-muted">{PAUSE_LABEL[task.pause]}</span>}
        {task.status === "active" && task.pause === "usage" && <span className="text-muted">Waiting for usage reset</span>}
      </div>
      {task.status === "paused" && task.lastError && <p className="m-0 text-ui-sm text-muted">{task.lastError}</p>}
      {task.status === "active" && task.nextAt !== null && <p className="m-0 text-ui-sm text-muted">Next wake {ago(task.nextAt)} · {wakeText(task.wake)}</p>}
      <SproutActions task={task} />
    </div>
  );
}
