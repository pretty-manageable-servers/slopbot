// Account: your profile in the picked server (name, avatar, the fields you saved, who may edit them), the cloud-model
// opt-in and log out. Port of the old console's My profile tab (web/app.js renderSettings) and nonZdrUserCard.
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Button, Switch, TextField } from "slop-ui-components";
import { useState } from "react";
import { ApiError, api, get, post } from "../../api";
import type { NonZdr, ServerSnapshot, SettingArgs, UserProfile } from "../../api-types";
import { settingsQuery, useSaveSetting, useServer } from "../../data";
import { confirmAction, notify, notifyError } from "../../ui/feedback";
import { SectionNote, SettingsGroup, SettingsRow } from "../../ui/layout";

// Same limits as the old form.
const FIELD_MAX = 100;
const VALUE_MAX = 2000;
// The bot's avatars come from Discord's CDN. Other URLs get the letter tile, as the old console did.
const AVATAR_HOST = "https://cdn.discordapp.com/";

/** The cloud-model opt-in. 404 means the bot does not offer it here, so the group stays hidden. */
const nonZdrKey = ["settings", "non-zdr"] as const;
const nonZdrQuery = queryOptions({
  queryKey: nonZdrKey,
  queryFn: () => get<NonZdr>("/api/settings/non-zdr").catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }),
});

export default function Account() {
  const server = useServer();
  const { data: snapshot } = useSuspenseQuery(settingsQuery(server.id));
  return (
    <>
      {snapshot.profile ? <ProfileGroups snapshot={snapshot} profile={snapshot.profile} /> : <SectionNote>Your profile is not available in this server.</SectionNote>}
      <DataGroup />
      <SettingsGroup title="Session">
        <SettingsRow label="Sign out of this browser">
          <Button variant="outline" size="sm" onPress={() => void api.logout().then(() => location.reload(), notifyError)}>Log out</Button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function ProfileGroups({ snapshot, profile }: { snapshot: ServerSnapshot; profile: UserProfile }) {
  const server = snapshot.server.name;
  const save = useSaveSetting(snapshot.server.id);
  const [fieldName, setFieldName] = useState("");
  const [fieldValue, setFieldValue] = useState("");
  const saveProfile = (args: SettingArgs["profile"], done?: () => void) => save.mutate({ name: "profile", args }, {
    onSuccess: (result) => { notify(result.text); done?.(); },
    onError: notifyError,
  });
  const remove = async (field: string) => {
    if (await confirmAction({ title: `Remove ${field}?`, confirmLabel: "Remove", danger: true })) saveProfile({ action: "remove", field });
  };
  const canSave = fieldName.trim() !== "" && fieldValue.trim() !== "";

  return (
    <>
      <SettingsGroup title="Profile">
        <SettingsRow label={<span className="flex items-center gap-3"><Avatar name={snapshot.me.displayName} url={snapshot.me.avatarUrl} /><span>{snapshot.me.displayName}</span></span>} help={`User ID ${snapshot.me.id}`} />
      </SettingsGroup>

      <SettingsGroup title={`Profile in ${server}`} description="Your profile is public to this Discord server. You control who can edit it.">
        <Switch toggleSide="end" className="py-3" isSelected={profile.allowEdits} isDisabled={save.isPending} onChange={(allow_edits) => saveProfile({ action: "lock", allow_edits })}>Allow other members to edit my profile</Switch>
      </SettingsGroup>

      <SettingsGroup title="Saved profile fields">
        {profile.fields.map((item) => (
          <SettingsRow key={item.field} label={item.field}
            help={<><span className="block break-words whitespace-pre-wrap">{typeof item.value === "string" ? item.value : JSON.stringify(item.value)}</span><span className="block">{item.editor === snapshot.user ? "Self-reported" : "Added by another member"}</span></>}>
            <Button variant="outline" size="sm" isDisabled={save.isPending} onPress={() => void remove(item.field)}>Remove</Button>
          </SettingsRow>
        ))}
        {!profile.fields.length && <p className="m-0 py-3 text-ui text-muted">No custom fields yet.</p>}
      </SettingsGroup>

      <SettingsGroup title="Add or update a field" description={`Your profile in ${server}`}
        actions={<Button variant="secondary" size="sm" isDisabled={!canSave || save.isPending} onPress={() => saveProfile({ action: "set", field: fieldName, value: fieldValue }, () => { setFieldName(""); setFieldValue(""); })}>Save</Button>}>
        <SettingsRow label="Field name" stack>
          <TextField aria-label="Field name" value={fieldName} onChange={setFieldName} placeholder="interests" maxLength={FIELD_MAX} />
        </SettingsRow>
        <SettingsRow label="Value" stack>
          <TextField aria-label="Value" value={fieldValue} onChange={setFieldValue} placeholder="What would you like your team to know?" maxLength={VALUE_MAX} />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function DataGroup() {
  const client = useQueryClient();
  const { data: nonZdr } = useSuspenseQuery(nonZdrQuery);
  const save = useMutation({
    mutationFn: (allow: boolean) => post<NonZdr>("/api/settings/non-zdr", { allow }),
    onSuccess: (next) => {
      client.setQueryData(nonZdrKey, next);
      notify(next.allow ? "Cloud models are allowed for you when ours are down." : "Cloud models are off for you.");
    },
    onError: notifyError,
  });
  if (!nonZdr) return null;

  const change = async (allow: boolean) => {
    // Turning it on needs a confirm. Cancel leaves the switch off.
    if (allow && !await confirmAction({
      title: "Allow cloud models?",
      body: "When Slopbot's own models are down, your prompts can go to cloud models. Those providers do not keep zero data retention.",
      confirmLabel: "Allow",
    })) return;
    save.mutate(allow);
  };

  return (
    <SettingsGroup title="Data">
      <Switch toggleSide="end" className="py-3" description="When Slopbot's models are down, some of your prompts can go to cloud models. In private chats and DMs, this setting is enough. In a server, the server must also allow cloud models." isSelected={nonZdr.allow} isDisabled={save.isPending} onChange={(allow) => void change(allow)}>Allow cloud models when ours are down (not zero data retention)</Switch>
    </SettingsGroup>
  );
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  return url !== null && url.startsWith(AVATAR_HOST)
    ? <img src={url} alt="" width={36} height={36} className="size-9 shrink-0 rounded-full" referrerPolicy="no-referrer" />
    : <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-hover text-ui font-semibold">{name.slice(0, 1).toUpperCase()}</span>;
}
