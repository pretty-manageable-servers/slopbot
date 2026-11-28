// A sprout's rules, wake and effort. Save sends them with the revision the form was made on. When the bot answers 409
// the sprout changed since, so the sprout is fetched again and the form starts over from it.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, DataTable, NumberField, Select, SegmentedControl, SettingsGroup, TextField } from "slop-ui-components";
import { useState } from "react";
import { ApiError, api } from "../api";
import type { AssistantTask, Effort, RuleEffect, Wake } from "../api-types";
import { notify, notifyError } from "../ui/feedback";
import { EFFORTS, RULE_EFFECTS } from "./format";
import { assistantKey } from "./queries";

const WAKE_KINDS = [{ id: "interval", label: "Every few minutes" }, { id: "cron", label: "On a schedule" }] as const;

export function SproutEditor({ task, timezone }: { task: AssistantTask; timezone: string }) {
  const client = useQueryClient();
  const [rules, setRules] = useState(task.rules);
  const [tool, setTool] = useState("");
  const [wakeKind, setWakeKind] = useState<Wake["kind"]>(task.wake.kind);
  const [minutes, setMinutes] = useState(task.wake.kind === "interval" ? task.wake.minutes : 60);
  const [cron, setCron] = useState(task.wake.kind === "cron" ? task.wake.cron : "0 8 * * *");
  const [zone, setZone] = useState(task.wake.kind === "cron" ? task.wake.timezone : timezone);
  const [effort, setEffort] = useState<Effort>(task.effort);

  const wakeOk = wakeKind === "interval" ? Number.isInteger(minutes) && minutes >= 1 : cron.trim() !== "" && zone.trim() !== "";
  const wake: Wake = wakeKind === "interval" ? { kind: "interval", minutes } : { kind: "cron", cron: cron.trim(), timezone: zone.trim() };
  const save = useMutation({
    mutationFn: () => api.updateSprout(task.id, { wake, rules, effort, revision: task.revision }),
    onSuccess: () => {
      notify("Sprout saved.");
      void client.invalidateQueries({ queryKey: assistantKey });
    },
    onError: (error) => {
      notifyError(error);
      if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: assistantKey });
    },
  });

  const ruleRows = Object.entries(rules).sort(([a], [b]) => a.localeCompare(b));
  const addRule = () => {
    const name = tool.trim();
    if (!name || Object.hasOwn(rules, name)) return;
    setRules({ ...rules, [name]: "ask" });
    setTool("");
  };

  return (
    <>
      <SettingsGroup title="Rules" description="What Bud may do with each tool. A tool without a rule asks first.">
        <DataTable
          aria-label="Tool rules"
          rows={ruleRows}
          rowKey={([name]) => name}
          emptyState="No rules yet."
          columns={[
            { id: "tool", header: "Tool", cell: ([name]) => name, isRowHeader: true },
            {
              id: "effect", header: "Effect", cell: ([name, effect]) => (
                <Select variant="quiet" aria-label={`Effect for ${name}`} options={RULE_EFFECTS} value={effect}
                  onChange={(next) => setRules({ ...rules, [name]: next as RuleEffect })} />
              ),
            },
          ]}
        />
        <div className="flex items-end gap-2">
          <TextField label="Tool name" value={tool} onChange={setTool} placeholder="github_comment" className="min-w-0 flex-1" />
          <Button variant="outline" size="sm" isDisabled={!tool.trim()} onPress={addRule}>Add rule</Button>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Wake" description="When Bud looks at this sprout again.">
        <Select label="Wake" options={WAKE_KINDS} value={wakeKind} onChange={(next) => setWakeKind(next as Wake["kind"])} />
        {wakeKind === "interval" ? (
          <NumberField label="Every, minutes" value={minutes} onChange={setMinutes} minValue={1} />
        ) : (
          <>
            <TextField label="Cron" value={cron} onChange={setCron} placeholder="0 8 * * *" />
            <TextField label="Timezone" value={zone} onChange={setZone} placeholder="Europe/Berlin" />
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="Effort" description="How much thinking Bud does on each wake. Extra high takes longer and costs more.">
        <SegmentedControl aria-label="Effort" options={EFFORTS} value={effort} onChange={(next) => setEffort(next as Effort)} />
      </SettingsGroup>

      <Button variant="primary" isDisabled={!wakeOk || save.isPending} onPress={() => save.mutate()}>Save sprout</Button>
    </>
  );
}
