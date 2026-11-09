// Command palette (Cmd+K on Mac, Ctrl+K elsewhere): a Modal near the top with a borderless search field, filter pills
// and sections of chats, channels, servers, actions and message hits, as web/palette.js. The matching and the
// sections are in palette-search.ts. Opening it again starts empty: the state lives in the part that is mounted
// while the palette is open.
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { IconButton, Modal, defaultIcons } from "agentic-ui-kit";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.key || "").toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setOpen(current => !current);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <Modal isOpen={open} onOpenChange={setOpen} aria-label="Command palette"
      className="self-start mt-[12vh] w-[min(640px,calc(100vw-2rem))]! max-w-none! overflow-hidden p-0">
      {open && <Palette onDone={() => setOpen(false)} />}
    </Modal>
  );
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
  const [active, setActive] = useState(0);
  const [picks] = useState(readRecent);
  const inputRef = useRef<HTMLInputElement>(null);
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
  // Each row gets its position in the list, so the arrow keys follow the screen and aria-activedescendant points at it.
  let position = 0;
  const layout = sections.map(section => ({ ...section, rows: section.items.map(item => ({ item, index: position++ })) }));
  const shown = sections.flatMap(section => section.items);
  const index = shown.length ? Math.min(active, shown.length - 1) : -1;
  useEffect(() => { document.getElementById(`palette-opt-${index}`)?.scrollIntoView({ block: "nearest" }); }, [index]);

  const choose = (row: Row) => {
    if (row.group !== "messages") saveRecent(pushRecent(picks, row.key));
    onDone();
    row.run();
  };
  const pick = (next: Filter) => { setFilter(next); setActive(0); };
  // Left or Right moves to the next or previous filter, and wraps at the ends.
  const stepFilter = (step: number) => {
    const at = FILTERS.findIndex(([key]) => key === filter);
    pick(FILTERS[(at + step + FILTERS.length) % FILTERS.length]![0]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); if (shown.length) setActive((index + 1) % shown.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); if (shown.length) setActive((index - 1 + shown.length) % shown.length); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // Left and Right change the filter only when the field is empty or the caret is at its start (Left) or end (Right).
      const input = event.currentTarget;
      const collapsed = input.selectionStart === input.selectionEnd;
      const atEdge = event.key === "ArrowLeft" ? input.selectionStart === 0 : input.selectionEnd === input.value.length;
      if (!input.value || (collapsed && atEdge)) { event.preventDefault(); stepFilter(event.key === "ArrowLeft" ? -1 : 1); }
    }
    else if (event.key === "Enter") { event.preventDefault(); const row = shown[index]; if (row) choose(row); }
  };

  return (
    <div className="flex max-h-[70dvh] min-h-0 flex-col">
      <div className="flex items-center gap-2 py-2 pr-2 pl-4">
        <span className="text-chat-muted">{icons.search}</span>
        <input ref={inputRef} autoFocus type="text" role="combobox" aria-expanded={shown.length > 0} aria-controls="palette-list" aria-autocomplete="list"
          aria-activedescendant={index >= 0 ? `palette-opt-${index}` : undefined} aria-label="Search" placeholder="Search" autoComplete="off" spellCheck={false}
          maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-base text-chat-fg outline-none placeholder:text-chat-muted" />
        <IconButton label="Close" onPress={onDone}>{icons.close}</IconButton>
      </div>
      <div role="group" aria-label="Filter" className="flex flex-wrap gap-1.5 px-4 pb-2">
        {FILTERS.map(([key, name]) => (
          <button key={key} type="button" aria-pressed={filter === key}
            onClick={() => { pick(key); inputRef.current?.focus(); }}
            className={`rounded-full border px-2.5 py-0.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-chat-focus ${filter === key ? "border-chat-fg bg-chat-selected text-chat-fg" : "border-chat-border text-chat-muted hover:bg-chat-hover"}`}>
            {name}
          </button>
        ))}
      </div>
      <hr className="m-0 border-chat-divider" />
      {/* With no rows (a search status only) it is a plain group: a listbox needs options. */}
      <ul id="palette-list" role={shown.length ? "listbox" : "group"} aria-label="Results" className="m-0 min-h-0 list-none overflow-y-auto p-2">
        {layout.map(section => (
          <Fragment key={section.title}>
            <li role="presentation" className="px-2.5 pt-2 pb-1 text-xs text-chat-muted">{section.title}</li>
            {section.rows.map(({ item, index: at }) => (
              <li key={`${section.title}:${item.key}`} id={`palette-opt-${at}`} role="option" aria-selected={at === index} data-index={at}
                onPointerMove={() => { if (at !== index) setActive(at); }}
                onClick={() => choose(item)}
                className={`flex cursor-pointer items-center gap-3 rounded-chat-sm px-2.5 py-2 text-sm ${at === index ? "bg-chat-hover" : ""}`}>
                <span className="flex w-5 shrink-0 justify-center text-chat-muted">{item.icon}</span>
                {item.snippet ? (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{highlight(item.snippet.text, text)}</span>
                    <span className="block truncate text-xs text-chat-muted">{item.snippet.meta}</span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                )}
                {item.detail && <span className="shrink-0 text-xs text-chat-muted">{item.detail}</span>}
              </li>
            ))}
            {section.status && <li role="presentation" className="px-2.5 py-2 text-sm text-chat-muted">{section.status}</li>}
          </Fragment>
        ))}
      </ul>
      {!shown.length && !sections.some(section => section.status) && <p className="m-0 px-4 py-6 text-center text-sm text-chat-muted">No matches.</p>}
      <div className="flex flex-wrap gap-4 border-t border-chat-divider px-4 py-2 text-xs text-chat-muted">
        <span>Close <kbd className="font-sans">Esc</kbd></span>
        <span>Change type <kbd className="font-sans">←</kbd> <kbd className="font-sans">→</kbd></span>
        <span>Open <kbd className="font-sans">↵</kbd></span>
      </div>
    </div>
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
  return text.split(new RegExp(`(${words.join("|")})`, "gi")).map((part, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-chat-selected text-chat-fg">{part}</mark> : part));
}

// The recent picks live in this browser. Storage can be unavailable (private mode): then there are no picks.
function readRecent(): string[] {
  try { return parseRecent(localStorage.getItem(RECENT_KEY)); } catch { return []; }
}
function saveRecent(picks: string[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(picks)); } catch { /* private mode: kept until reload */ }
}
