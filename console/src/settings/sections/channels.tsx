// Channels & history settings: which channels Slopbot monitors, and for each monitored channel its saved history (the
// import progress, pause or resume, and the window of days kept). Ported from the old console's Channels tab; the
// pure parts are in channels-format.ts.
import { useSuspenseQuery } from "@tanstack/react-query";
import { Button, confirm, NumberField, ProgressBar, SearchField, SettingsGroup, SettingsRow, Switch } from "slop-ui-components";
import { useState } from "react";
import type { SnapshotChannel } from "../../api-types";
import { settingsQuery, useSaveSetting, useServer, type SaveSetting } from "../../data";
import { notify, notifyError } from "../../ui/feedback";
import { SectionNote } from "../../ui/layout";
import { historyProgress, historyStatus, isWindowDays, needsChannelFilter, visibleChannels, type HistoryStatus } from "./channels-format";

// While an import runs, the snapshot is read again every 2 seconds, as the old console did.
const POLL_MS = 2000;
const TONE: Record<HistoryStatus["tone"], string> = { danger: "text-danger", warning: "text-warning", muted: "text-muted" };

export default function Section() {
  const server = useServer();
  const [filter, setFilter] = useState("");
  const { data: snapshot } = useSuspenseQuery({
    ...settingsQuery(server.id),
    refetchInterval: (query) => (query.state.data?.channels.some((c) => c.history?.job) ? POLL_MS : false),
  });
  if (!snapshot.admin) return <SectionNote>Manage Server permission is required for these controls.</SectionNote>;
  const { channels } = snapshot;
  const rows = visibleChannels(channels, filter);
  return (
    <SettingsGroup description="Manage monitored channels and saved chat history. Only saved lessons and memories use embeddings.">
      {needsChannelFilter(channels.length) && <SearchField aria-label="Filter channels" placeholder="Filter channels" value={filter} onChange={setFilter} className="py-3" />}
      {!channels.length
        ? <SectionNote>No text channels are visible to both you and Slopbot.</SectionNote>
        : rows.length
          ? rows.map((channel) => <ChannelRow key={channel.id} server={server.id} channel={channel} />)
          : <SectionNote>No channels match this filter.</SectionNote>}
    </SettingsGroup>
  );
}

function ChannelRow({ server, channel }: { server: string; channel: SnapshotChannel }) {
  const { id, name, monitored, history } = channel;
  const save = useSaveSetting(server);
  // The window field keeps what the user typed until it is saved; empty or bad text reads as NaN.
  const [draft, setDraft] = useState<number | null>(null);
  const days = draft ?? history?.days ?? Number.NaN;
  const status = historyStatus(history);
  const progress = historyProgress(history);
  const busy = save.isPending;

  const saveSetting = (payload: SaveSetting) => save.mutate(payload, { onSuccess: (result) => notify(result.text || "Saved."), onError: notifyError });
  const setMonitored = async (on: boolean) => {
    if (!on && !(await confirm({ title: "Stop monitoring this channel?", description: "This purges searchable content and dependent task context. Operational logs remain.", confirmLabel: "Stop monitoring", destructive: true }))) return;
    saveSetting({ name: "channels", args: { action: on ? "add" : "remove", channel: id }, channel: id });
  };
  const saveWindow = async () => {
    if (!isWindowDays(days)) return;
    // A shorter window deletes saved messages. Cancel changes nothing.
    if (history && days < history.days && !(await confirm({ title: "Delete older messages?", description: `Delete saved messages older than ${days} days in #${name}? This cannot be undone.`, confirmLabel: "Delete", destructive: true }))) return;
    saveSetting({ name: "index", args: { action: "window", days }, channel: id });
  };

  const help = !monitored
    ? "Not monitored"
    : history
      ? <><span className={TONE[status.tone]}>{status.label}</span> · {history.days} days</>
      : "Monitored";

  return (
    <div className="flex flex-col">
      <SettingsRow label={`#${name}`} description={help}>
        <Switch aria-label={`Monitor #${name}`} isSelected={monitored} onChange={setMonitored} isDisabled={busy} />
      </SettingsRow>
      {monitored && history && (
        <div className="flex flex-col gap-3 pb-3">
          {progress && (
            <div className="flex flex-col gap-1.5">
              {progress.percent !== null && <ProgressBar aria-label="Import progress" value={progress.percent} />}
              <p className="m-0 text-ui text-muted">{progress.text}</p>
            </div>
          )}
          <div>
            <Button variant="outline" size="sm" onPress={() => saveSetting({ name: "index", args: { action: history.paused ? "resume" : "pause" }, channel: id })} isDisabled={busy}>{history.paused ? "Resume import" : "Pause import"}</Button>
          </div>
          <form className="flex flex-col gap-1" onSubmit={(event) => { event.preventDefault(); void saveWindow(); }}>
            <div className="flex flex-wrap items-center gap-2">
              <NumberField aria-label="History window in days" value={days} onChange={setDraft} minValue={1} maxValue={3650} description="Lowering the window deletes saved messages older than the new window." />
              <span className="text-ui text-muted">days</span>
              <Button type="submit" variant="outline" size="sm" isDisabled={busy || !isWindowDays(days)}>Save</Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
