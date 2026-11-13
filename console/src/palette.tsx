// Command palette (Cmd+K on Mac, Ctrl+K elsewhere): the library's CommandPalette over sections of chats, channels,
// servers, actions and message hits, as web/palette.js. The matching and the sections are in palette-search.ts: the
// library's own filter is off (filter={false}), so the fuzzy ranking decides what shows. Opening it again starts empty: the state lives in the part that is mounted while it is open.
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { defaultIcons } from "agentic-ui-kit";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, CommandItem, CommandPalette as LibraryPalette, CommandSection, Kbd, useCommandPaletteShortcut } from "slop-ui-components";
import { get, qs } from "./api";
import type { Conversation, ConversationSearch } from "./api-types";
import { adminMeQuery, chatsQuery, pickServer, sessionQuery, useServer } from "./data";
import { readPrefs, savePrefs } from "./prefs";
import { buildSections, FILTERS, parseRecent, pushRecent, RECENT_KEY, recentItems, snippetOf, type Filter, type PaletteItem } from "./palette-search";
import { useOpenSettings } from "./settings/dialog";
import { SECTIONS } from "./settings/sections";
import { icons } from "./ui/icons";
import { ago } from "./ui/time";
import { ServerMark } from "./ui/layout";

/** A row as drawn: the item, its icon and detail, a snippet for a message hit, and what Enter does. */
type Row = PaletteItem & { icon: ReactNode; detail?: string; snippet?: { text: string; meta: string }; run: () => void };

/** The command palette: Ctrl+K or Cmd+K opens it. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  useCommandPaletteShortcut(() => setOpen(current => !current));
  return open ? <Palette onDone={() => setOpen(false)} /> : null;
}

function Palette({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const openSettings = useOpenSettings();
  const server = useServer();
  const servers = useQuery(sessionQuery).data?.servers ?? [];
  const { data: team } = useQuery(adminMeQuery);
  const { data: chats = [] } = useQuery(chatsQuery);
  const { data: conversations = [] } = useQuery({
    queryKey: ["conversations", server.id],
    queryFn: () => get<{ conversations: Conversation[] }>(`/api/conversations${qs({ server: server.id })}`).then(response => response.conversations),
  });

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [picks] = useState(readRecent);
  const text = query.trim();

  // Message search waits 250 ms after the last key, and runs from two letters. Hits show once the search is done.
  const debounced = useDebounced(text, 250);
  const search = useQuery({
    queryKey: ["conversations", server.id, "search", debounced],
    queryFn: () => get<ConversationSearch>(`/api/conversations/search${qs({ server: server.id, q: debounced })}`),
    enabled: debounced.length >= 2,
  });
  const loading = text.length >= 2 && (debounced !== text || search.isFetching);
  const channelNames = new Map((search.data?.channels ?? []).map(channel => [channel.id, channel.name]));
  const light = document.documentElement.dataset.chatTheme === "light";

  const all: Row[] = [
    ...chats.map((chat): Row => ({
      key: `chat:${chat.id}`, group: "chats", name: chat.title || "New chat", ts: chat.updated,
      icon: icons.chats, detail: ago(chat.updated),
      run: () => void navigate({ to: "/chat/$chatId", params: { chatId: chat.id } }),
    })),
    ...conversations.map((conversation): Row => ({
      key: `channel:${conversation.id}`, group: "channels", name: conversation.name, ts: conversation.newest ?? undefined,
      icon: conversation.kind === "thread" ? icons.thread : icons.channels,
      detail: conversation.newest ? ago(conversation.newest) : undefined,
      run: () => void navigate({ to: "/server/$serverId/channel/$channelId", params: { serverId: server.id, channelId: conversation.id } }),
    })),
    ...servers.map((picked): Row => ({
      key: `server:${picked.id}`, group: "servers", name: picked.name,
      icon: <ServerMark server={picked} size={18} />, detail: picked.id === server.id ? "Current" : undefined,
      run: () => { pickServer(picked.id); void navigate({ to: "/server/$serverId", params: { serverId: picked.id } }); },
    })),
    { key: "action:new-chat", group: "actions", name: "New chat", icon: defaultIcons.edit, run: () => void navigate({ to: "/" }) },
    ...SECTIONS.filter(section => section.group !== "admin" || team).map((section): Row => ({
      key: `action:settings:${section.id}`, group: "actions", name: `Settings: ${section.label}`, icon: section.icon,
      run: () => openSettings(section.id),
    })),
    {
      key: "action:theme", group: "actions", name: light ? "Switch to dark theme" : "Switch to light theme", icon: icons.appearance,
      run: () => savePrefs({ ...readPrefs(), theme: light ? "dark" : "light" }),
    },
  ];

  const messagesReady = text.length >= 2 && !loading;
  const messageRows: Row[] = messagesReady
    ? (search.data?.messages ?? []).map((message): Row => ({
      key: `message:${message.id}`, group: "messages", name: message.text, icon: icons.chats,
      detail: message.timestamp ? ago(message.timestamp) : undefined,
      snippet: { text: snippetOf(message.text, text), meta: `${channelNames.get(message.channel) ?? ""} · ${message.authorName}` },
      run: () => void navigate({ to: "/server/$serverId/channel/$channelId", params: { serverId: server.id, channelId: message.channel } }),
    }))
    : [];
  const messageStatus = loading ? "Searching messages…" : search.error ? search.error.message : messageRows.length ? undefined : "No messages match";

  const sections = buildSections(all, text, filter, recentItems(all, picks), { items: messageRows, status: messageStatus });
  const status = sections.flatMap(section => section.status ?? []);

  // Left and Right step the filter when the field is empty or the caret is collapsed at the start (Left) or end (Right).
  const stepFilter = (event: KeyboardEvent<HTMLInputElement>) => {
    const { selectionStart, selectionEnd, value } = event.currentTarget;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const collapsed = selectionStart === selectionEnd;
    if (!step || (value && !(collapsed && (step > 0 ? selectionEnd === value.length : selectionStart === 0)))) return;
    event.preventDefault();
    const at = FILTERS.findIndex(([key]) => key === filter);
    setFilter(FILTERS[(at + step + FILTERS.length) % FILTERS.length]![0]);
  };

  const choose = (row: Row) => {
    if (row.group !== "messages") saveRecent(pushRecent(picks, row.key));
    row.run();
  };

  return (
    <LibraryPalette isOpen onOpenChange={open => !open && onDone()} placeholder="Search" emptyMessage="No matches."
      query={query} onQueryChange={setQuery} filter={false} onInputKeyDown={stepFilter}
      toolbar={
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(([key, name]) => (
            <Button key={key} size="sm" variant={key === filter ? "secondary" : "ghost"} aria-pressed={key === filter} onPress={() => setFilter(key)}>{name}</Button>
          ))}
        </div>
      }
      status={status.length ? status.join(" · ") : undefined}
      footer={<><span>Close <Kbd>Esc</Kbd></span><span>Change type <Kbd>←</Kbd> <Kbd>→</Kbd></span><span>Open <Kbd>↵</Kbd></span></>}>
      {sections.filter(section => section.items.length).map(section => (
        <CommandSection key={section.title} title={section.title}>
          {section.items.map(item => (
            <CommandItem key={item.key} id={`${section.title}:${item.key}`} textValue={item.name} icon={item.icon} detail={item.detail}
              description={item.snippet?.meta} onAction={() => choose(item)}>
              {item.snippet ? highlight(item.snippet.text, text) : item.name}
            </CommandItem>
          ))}
        </CommandSection>
      ))}
    </LibraryPalette>
  );
}

/** The value after it has stayed the same for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

/** Marks each word of the query in the text. */
function highlight(text: string, query: string): ReactNode {
  const words = query.split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return text;
  return text.split(new RegExp(`(${words.join("|")})`, "gi")).map((part, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-selected text-fg">{part}</mark> : part));
}

// The recent picks live in this browser. Storage can be unavailable (private mode): then there are no picks.
function readRecent(): string[] {
  try { return parseRecent(localStorage.getItem(RECENT_KEY)); } catch { return []; }
}
function saveRecent(picks: string[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(picks)); } catch { /* private mode: kept until reload */ }
}
