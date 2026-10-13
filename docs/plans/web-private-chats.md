# Plan: private web chats

Status: in progress.

A signed-in user talks to Slopbot one to one in the web console, like claude.ai. The chat exists only on the web. The channel transcript view becomes read-only.

## Decisions

| Topic | Decision |
|---|---|
| Where a chat lives | Web only. Not in Discord. |
| Home server | The server picked in the console. Limits, settings, persona and model come from it. |
| Visibility | Only the owner sees the chat. Team admins see only usage numbers. |
| Memory | The chat can read the server's saved memories and lessons. It does not save new server memories unless the user asks (the existing remember tool). |
| Server tools | Read-only tools only (`effect: "read"`), plus web search and docs. No tool that changes the server, posts to Discord, or starts task threads. |
| Limits | The same UserLimiter gate as Discord. Over the limit: the message is refused before it is saved. |
| Channel view | Read-only. The composer is removed from channel and thread transcripts. |

## Data

- A private chat is a conversation with channel ID `web:<32 hex>` in the home server. Messages and runs use the existing tables, so runs, the run view and SSE work the same.
- New table `web_chats(id, server, owner, title, created, updated, deleted)`. `owner` is the Discord user ID.
- Every read and write checks `owner = session user` and that the user is still a member of the server. Otherwise 404.

## Privacy rules (must hold)

`web:` channels must never reach other users or server-wide context:

- History search (`src/search/history-search.ts`), context building for other channels, reports, participation (JEV), history import and indexing: exclude `channel LIKE 'web:%'`, or filter in the query.
- The memory extractor does not run on `web:` channels on its own.
- The channel list, transcripts, shares and the admin transcript list never show `web:` channels.
- Retention: chats are kept until the user deletes them. Delete removes messages, runs and events of that chat.
- Tests for each rule.

## Server

- `src/web-chats.ts`: create, list, rename, delete, messages page, send.
- Send: check owner, limit (`UserLimiter`), size (8000 characters). Save the user message (`author` = user, `addressed: true`, `source: "web"`), publish it on the stream, then hand it to the server's `Bot` with a web gateway.
- Web gateway (implements `ChatGateway`): `reply()` saves Slopbot's message and publishes it; `typing()` does nothing; `createTaskThread()` throws "Not available in private chats"; `react()` does nothing.
- `Bot.accepts` allows `web:` channels that exist in `web_chats` for that server. Participation is skipped (always addressed).
- Tools: in a `web:` channel, the registry offers only `effect: "read"` tools.
- Title: the first 60 characters of the first message (no extra model call).
- Routes (session required, CSRF on writes):
  - `GET /api/chats?server=` → `[{id, title, updated}]`
  - `POST /api/chats` `{server}` → `{id}`
  - `PATCH /api/chats/:id` `{title}`, `DELETE /api/chats/:id`
  - `GET /api/chats/:id/messages?before=` → same message shape as transcripts
  - `GET /api/chats/:id/stream` → same SSE events as conversations
  - `POST /api/chats/:id/messages` `{text}` → `{id}`

## Web UI

- List: "New chat" button at the top, a "Private chats" group above Channels, a lock icon on each chat, rename and delete in a small menu.
- A private chat uses the same chat pane: Markdown, runs, live status line, usage meter, composer.
- An empty new chat shows a centered greeting ("What's growing today?") and the composer.
- Channel and thread views: no composer. A note at the bottom: "Read-only. Reply in Discord."

## Steps

1. Server: table, store methods (SQLite and Postgres), privacy filters, routes, web gateway, tool filter, tests.
2. Web UI: private chat list and pane, read-only channel view.
3. Local test in the browser, then a PR.
