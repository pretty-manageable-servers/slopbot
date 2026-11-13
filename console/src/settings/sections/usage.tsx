// Usage: the plan and one row per limit window, with its bar, percent and reset time, and a button to use a banked
// reset. Port of the old console's usage meter (web/conversations.js usageMeter, paintUsage, resetButton).
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Button, Meter, type ProgressTone } from "slop-ui-components";
import { get, post, qs } from "../../api";
import type { Usage } from "../../api-types";
import { useServer } from "../../data";
import { confirmAction, notify, notifyError } from "../../ui/feedback";
import { SettingsGroup, SettingsRow } from "../../ui/layout";
import { resetsLabel, usageLevel, windowName, type UsageLevel } from "./usage-format";

export const usageQuery = (server: string) => queryOptions({
  queryKey: ["usage", server],
  queryFn: () => get<Usage>(`/api/usage${qs({ server })}`),
});

type UsageWindow = Usage["windows"][number];
const BAR_TONE: Record<UsageLevel, ProgressTone> = { low: "default", mid: "warning", high: "danger" };
/** The reset's name in the old console: "5-hour" for the 5-hour window, "full" for the week (which resets both). */
const resetName = (item: UsageWindow) => (item.kind === "5h" ? "5-hour" : "full");

export default function UsageSettings() {
  const server = useServer();
  const { data: usage } = useSuspenseQuery(usageQuery(server.id));
  const client = useQueryClient();
  const reset = useMutation({
    mutationFn: (item: UsageWindow) => post<Usage>("/api/usage/reset", { server: server.id, kind: item.kind }),
    onSuccess: (next, item) => {
      client.setQueryData(usageQuery(server.id).queryKey, next);
      notify(`Your ${resetName(item)} usage is reset.`);
    },
    onError: notifyError,
  });

  const askAndReset = async (item: UsageWindow) => {
    const confirmed = await confirmAction({
      title: `Use a ${resetName(item)} reset?`,
      body: item.kind === "5h" ? "Your 5-hour usage goes back to 0%." : "Your 5-hour and weekly usage go back to 0%.",
      confirmLabel: "Use reset",
    });
    if (confirmed) reset.mutate(item);
  };

  return (
    <SettingsGroup title="Limits" description={`Plan: ${usage.plan}`}>
      {usage.windows.map((item) => (
        <SettingsRow key={item.kind} label={windowName(item.kind)} help={item.resetAt ? resetsLabel(item.resetAt) : undefined}>
          <div className="flex w-56 flex-col items-end gap-1.5">
            {item.percent === null ? (
              <span className="text-ui text-muted">No limit</span>
            ) : (
              <div className="flex w-full items-center gap-3">
                <Meter aria-label={`${windowName(item.kind)} usage`} value={item.percent} tone={BAR_TONE[usageLevel(item.percent)]} className="flex-1" />
                <span className="w-20 text-right text-ui tabular-nums">{item.percent}% used</span>
              </div>
            )}
            {item.banked > 0 && (
              <Button variant="outline" size="sm" isDisabled={reset.isPending} onPress={() => void askAndReset(item)}>
                Use a reset ({item.banked})
              </Button>
            )}
          </div>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
