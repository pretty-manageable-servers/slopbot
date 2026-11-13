// Server settings for the picked server, as the old console's Server tab (web/app.js renderSettings). Each group saves
// on its own: a Switch or Select saves on change, a number group with its Save button. The bot's answer to a save
// shows as a notice; a failed save shows its error.
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Button, NumberField, Select, SettingsGroup, SettingsRow, Switch, TextField } from "slop-ui-components";
import { useState } from "react";
import { get, post, qs } from "../../api";
import type { ServerSettings, ToolResult, TranscriptChannel } from "../../api-types";
import { settingsQuery, useSaveSetting, useServer } from "../../data";
import { notify, notifyError } from "../../ui/feedback";
import { SectionNote } from "../../ui/layout";
import {
  badNumbers, calibrationArgs, cutoffsFrom, RANGES, VOICE_MAX_LENGTH, VOICE_RESET, voiceArgs,
  type NumberCheck, type Range,
} from "./server-form";

const VOICE_DEFAULT = "A clear, warm young adult American woman with a medium pitch, a smooth and even pace, crisp articulation and a calm, friendly, helpful assistant tone.";
const TOOL_DISPLAY = [
  { id: "none", label: "No tool calls" },
  { id: "summary", label: "Summary" },
  { id: "full", label: "Full expansion" },
] as const;
const EFFORT = [
  { id: "default", label: "Default" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "xhigh", label: "Extra" },
] as const;
const CUTOFFS = [
  { key: "addressed", label: "Addressed, %" },
  { key: "respond", label: "Addressed reply, %" },
  { key: "unsolicited", label: "Unsolicited reply, %" },
  { key: "funny", label: "Funny reaction, %" },
] as const;

/** A save's notice is the bot's answer text. */
const showAnswer = { onSuccess: (result: ToolResult) => notify(result.text), onError: notifyError };

export default function Section() {
  const server = useServer();
  const { data } = useSuspenseQuery(settingsQuery(server.id));
  if (!data.admin || !data.settings) return <SectionNote>Manage Server permission is required for these controls.</SectionNote>;
  return <ServerForms key={server.id} server={server.id} settings={data.settings} channel={data.channels[0]?.id} />;
}

interface Props { server: string; settings: ServerSettings }

/** The groups of one server. Keyed by server, so each group's form state starts from the picked server. */
function ServerForms({ server, settings, channel }: Props & { channel: string | undefined }) {
  return (
    <>
      <Monitoring server={server} settings={settings} />
      <Participation server={server} settings={settings} />
      <Context server={server} settings={settings} />
      <Cooldown server={server} settings={settings} />
      <Replies server={server} settings={settings} />
      <Voice server={server} channel={channel} />
      <WebTranscripts server={server} />
    </>
  );
}

function Monitoring({ server, settings }: Props) {
  const save = useSaveSetting(server);
  return (
    <SettingsGroup title="Join the conversation" description={settings.mock ? "Applies to this server. Mock mode disables automatic participation." : "Applies to this server."}>
      <Switch toggleSide="end" description="Direct mentions and replies still work when monitoring is off." isSelected={settings.monitoring} isDisabled={save.isPending} onChange={(enabled) => save.mutate({ name: "monitoring", args: { enabled } }, showAnswer)}>Monitor unaddressed conversations</Switch>
    </SettingsGroup>
  );
}

function Participation({ server, settings }: Props) {
  const save = useSaveSetting(server);
  const [cutoffs, setCutoffs] = useState(() => cutoffsFrom(settings.participation_thresholds));
  const bad = badNumbers(CUTOFFS.map(({ key, label }) => ({ label, value: cutoffs[key], range: RANGES.cutoff })));
  return (
    <SettingsGroup
      title="Participation"
      description="Applies immediately to this server. Lower cutoffs allow more participation. Use Slopbot’s why tool to compare recorded scores with the cutoffs used. Reaction frequency is a separate setting."
    >
      {CUTOFFS.map(({ key, label }) => (
        <NumberRow key={key} label={label} value={cutoffs[key]} range={RANGES.cutoff} onChange={(value) => setCutoffs((c) => ({ ...c, [key]: value }))} />
      ))}
      <NumberProblems bad={bad} />
    {saveButton(save.isPending || bad.length > 0, () => save.mutate({ name: "calibration", args: calibrationArgs(cutoffs) }, showAnswer))}
    </SettingsGroup>
  );
}

function Context({ server, settings }: Props) {
  const save = useSaveSetting(server);
  const [context, setContext] = useState({ jev: settings.classifier_context, reply: settings.reply_context });
  const bad = badNumbers([
    { label: "Participation context, messages", value: context.jev, range: RANGES.jevContext },
    { label: "Reply context, messages", value: context.reply, range: RANGES.replyContext },
  ]);
  // As the old console: participation context first, then reply context. A failed reply save says the first one went through.
  async function submit() {
    try {
      notify((await save.mutateAsync({ name: "context", args: { messages: context.jev, target: "jev" } })).text);
    } catch (error) {
      notifyError(error);
      return;
    }
    try {
      notify((await save.mutateAsync({ name: "context", args: { messages: context.reply, target: "reply" } })).text);
    } catch (error) {
      notifyError(new Error(`Participation context saved. Reply context failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return (
    <SettingsGroup title="Context" description="Applies to this server.">
      <NumberRow label="Participation context, messages" value={context.jev} range={RANGES.jevContext} onChange={(jev) => setContext((c) => ({ ...c, jev }))} />
      <NumberRow label="Reply context, messages" value={context.reply} range={RANGES.replyContext} onChange={(reply) => setContext((c) => ({ ...c, reply }))} />
      <NumberProblems bad={bad} />
    {saveButton(save.isPending || bad.length > 0, submit)}
    </SettingsGroup>
  );
}

function Cooldown({ server, settings }: Props) {
  const save = useSaveSetting(server);
  const [cooldown, setCooldown] = useState({ seconds: settings.cooldown_seconds, perHour: settings.max_unsolicited_per_hour });
  const bad = badNumbers([
    { label: "Minimum interval, seconds", value: cooldown.seconds, range: RANGES.cooldownSeconds },
    { label: "Replies per hour", value: cooldown.perHour, range: RANGES.repliesPerHour },
  ]);
  return (
    <SettingsGroup title="Cooldown" description="Server policy, counted separately for each channel.">
      <NumberRow label="Minimum interval, seconds" value={cooldown.seconds} range={RANGES.cooldownSeconds} onChange={(seconds) => setCooldown((c) => ({ ...c, seconds }))} />
      <NumberRow label="Replies per hour" help="Zero replies per hour disables unsolicited replies. Direct requests bypass these limits."
        value={cooldown.perHour} range={RANGES.repliesPerHour} onChange={(perHour) => setCooldown((c) => ({ ...c, perHour }))} />
      <NumberProblems bad={bad} />
    {saveButton(save.isPending || bad.length > 0, () => save.mutate({ name: "cooldown", args: { seconds: cooldown.seconds, per_hour: cooldown.perHour } }, showAnswer))}
    </SettingsGroup>
  );
}

function Replies({ server, settings }: Props) {
  const save = useSaveSetting(server);
  return (
    <SettingsGroup title="Replies">
      <SettingsRow label="Tool activity" description="Summary shows one grey line with counts. Full expansion adds failed calls and their reasons.">
        <Select variant="quiet" aria-label="Tool activity" options={TOOL_DISPLAY} value={settings.tool_display} isDisabled={save.isPending}
          onChange={(mode) => save.mutate({ name: "tool_display", args: { mode: mode } }, showAnswer)} />
      </SettingsRow>
      <SettingsRow label="Reasoning effort" description="Default for this server. Web chats can pick their own and use medium when nothing is set. Models without effort support ignore this.">
        <Select variant="quiet" aria-label="Reasoning effort" options={EFFORT} value={settings.default_effort} isDisabled={save.isPending}
          onChange={(level) => save.mutate({ name: "default_effort", args: { level: level } }, showAnswer)} />
      </SettingsRow>
      <Switch toggleSide="end" isSelected={settings.timing_footer} isDisabled={save.isPending} onChange={(enabled) => save.mutate({ name: "timing", args: { enabled } }, showAnswer)}>Show request timing in reply footers</Switch>
    </SettingsGroup>
  );
}

function Voice({ server, channel }: { server: string; channel: string | undefined }) {
  const save = useSaveSetting(server);
  const [instructions, setInstructions] = useState("");
  // The settings snapshot does not hold the voice text, so it comes from the voice status action.
  const status = useQuery({
    queryKey: ["settings", server, "voice"],
    queryFn: async () => {
      if (!channel) throw new Error("You and Slopbot need access to a server text channel.");
      return (await post<ToolResult>("/api/settings", { server, channel, name: "voice", args: { action: "status" } })).text;
    },
  });
  const current = status.isPending ? "Loading current voice…" : status.error ? status.error.message : status.data;
  return (
    <SettingsGroup title="Voice" description="Applies to voice channels in this server.">
      <p className={`m-0 py-3 text-ui ${status.error ? "text-danger" : "text-muted"}`}>{current}</p>
      <SettingsRow label="Voice instructions" className="flex-col items-stretch" description="Describe how Slopbot sounds in voice channels: gender, age, pitch, pace and tone. Leave empty for the default.">
        <TextField multiline aria-label="Voice instructions" value={instructions} onChange={setInstructions} placeholder={VOICE_DEFAULT} maxLength={VOICE_MAX_LENGTH} rows={3} />
      </SettingsRow>
      <div className="pb-3">
        <Button variant="ghost" size="sm" isDisabled={save.isPending} onPress={() => save.mutate({ name: "voice", args: VOICE_RESET }, showAnswer)}>Reset to default</Button>
      </div>
    {saveButton(save.isPending, () => save.mutate({ name: "voice", args: voiceArgs(instructions) }, showAnswer))}
    </SettingsGroup>
  );
}

function WebTranscripts({ server }: { server: string }) {
  const client = useQueryClient();
  const channels = useQuery({
    queryKey: ["transcripts", server],
    queryFn: () => get<{ channels: TranscriptChannel[] }>(`/api/web-transcripts/channels${qs({ server })}`).then((r) => r.channels),
  });
  const toggle = useMutation({
    mutationFn: ({ channel, enabled }: { channel: string; name: string; enabled: boolean }) =>
      post<{ enabled: boolean }>("/api/web-transcripts/channels", { server, channel, enabled }),
    onSettled: () => client.invalidateQueries({ queryKey: ["transcripts", server] }),
  });
  return (
    <SettingsGroup title="Web transcripts" description="Per channel. Off by default. Turn a channel on to show its transcript in the web console. Discord permissions still decide who can see it.">
      {channels.isPending && <SectionNote>Loading channels…</SectionNote>}
      {channels.error && <p className="m-0 py-3 text-ui text-danger">{channels.error.message}</p>}
      {channels.data?.length === 0 && <SectionNote>Slopbot serves no channels in this server yet.</SectionNote>}
      {channels.data?.map((channel) => (
        <SettingsRow key={channel.id} label={`#${channel.name}`}>
          <span className="text-ui text-muted">{channel.enabled ? "On" : "Off"}</span>
          <Switch aria-label={`Web transcripts for #${channel.name}`} isSelected={channel.enabled} isDisabled={toggle.isPending && toggle.variables?.channel === channel.id}
            onChange={(enabled) => toggle.mutate({ channel: channel.id, name: channel.name, enabled }, {
              onSuccess: (result) => notify(`Web transcripts ${result.enabled ? "on" : "off"} for #${channel.name}`),
              onError: notifyError,
            })} />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

/** A number row: the label and help on the left, a field with the range's limits on the right. */
function NumberRow({ label, help, value, range, onChange }: { label: string; help?: string; value: number; range: Range; onChange: (value: number) => void }) {
  return (
    <SettingsRow label={label} description={help}>
      <NumberField aria-label={label} value={value} minValue={range.min} maxValue={range.max} onChange={onChange} />
    </SettingsRow>
  );
}

/** Names the number fields that block Save, with their limits. */
function NumberProblems({ bad }: { bad: NumberCheck[] }) {
  if (!bad.length) return null;
  return <p className="m-0 pt-3 text-ui text-danger">{bad.map(({ label, range }) => `${label} must be a whole number from ${range.min} to ${range.max}.`).join(" ")}</p>;
}

const saveButton = (disabled: boolean, onPress: () => void) => <div className="flex justify-end"><Button variant="secondary" size="sm" isDisabled={disabled} onPress={onPress}>Save</Button></div>;
