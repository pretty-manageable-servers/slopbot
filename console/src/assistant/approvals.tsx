// Waiting for you: the tool calls Bud asks to make. Approve or deny each one; "Always allow" also sets the tool's rule.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Badge } from "slop-ui-components";
import { api } from "../api";
import type { ApprovalRequest } from "../api-types";
import { notifyError } from "../ui/feedback";
import { ago } from "../ui/time";
import { assistantKey } from "./queries";

export function Approvals({ approvals }: { approvals: ApprovalRequest[] }) {
  if (approvals.length === 0) return <p className="m-0 text-ui-sm text-muted">Nothing is waiting for you.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {approvals.map((approval) => <li key={approval.id}><ApprovalCard approval={approval} /></li>)}
    </ul>
  );
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const client = useQueryClient();
  const decide = useMutation({
    mutationFn: ({ decision, always }: { decision: "approve" | "deny"; always?: boolean }) => api.decideApproval(approval.id, decision, always),
    onSuccess: ({ approval: decided }) => {
      // The bot answers 200 when the approved tool itself failed. Its error is the approval's result.
      if (decided.status === "failed") notifyError(new Error(`${decided.tool} failed: ${decided.result ?? "no error text"}`));
      void client.invalidateQueries({ queryKey: assistantKey });
    },
    onError: notifyError,
  });
  return (
    <Card className="flex flex-col gap-2">
      <Badge tone="warning" className="self-start">{approval.tool}</Badge>
      <p className="m-0 text-ui">{approval.summary}</p>
      <p className="m-0 text-ui-sm text-muted">Expires {ago(approval.expiresAt)}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" isDisabled={decide.isPending} onPress={() => decide.mutate({ decision: "approve" })}>Approve</Button>
        <Button variant="outline" size="sm" isDisabled={decide.isPending} onPress={() => decide.mutate({ decision: "deny" })}>Deny</Button>
        <Button variant="ghost" size="sm" isDisabled={decide.isPending} onPress={() => decide.mutate({ decision: "approve", always: true })}>Always allow</Button>
      </div>
    </Card>
  );
}
