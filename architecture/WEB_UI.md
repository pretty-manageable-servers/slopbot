# Slopbot web client and console

The web client is the HTTP app in `src/clients/web/`. It runs in the bot process on `node:http`, through Hono and `@hono/node-server`. It serves the console at `/console` and the JSON API the console uses. The console is a same-origin single-page app in `console/` (Vite, React and agentic-ui-kit). It uses the engine through the `Engine` interface and Discord authority through `Directory`. It does not keep a second settings database: it uses the same tool registry, live Discord permissions and settings as the slash commands. The client does not import the Discord client. See [engine and clients](ADAPTERS.md).

## Layout

- `src/clients/web/app.ts`: `createApp` builds the Hono app. Routes run in registration order, and that order is the check order: public pages, the session check, the chat and transcript routes, the other routes, then static files. Writes must pass the Origin and `X-CSRF-Token` check (`guard`).
- `src/clients/web/env.ts`: the request types, `userOf`, `applyOut` and `failure`, which handles errors after a stream has started.
- `src/clients/web/body.ts`: body reading with size limits (`readBytes`, `readJson`) and zod checks (`check`).
- `src/clients/web/routes/*.ts`: one file per route group: `auth`, `account`, `chats`, `conversations`, `shares`, `admin`, `static` and `version`. A chat route is one line in `routes/chats.ts`. The body reading and the Origin and CSRF checks run before it.
- `src/clients/web/web-chats.ts`: `WebChatService`, the private chats, and `WebChatGateway`, which saves and publishes replies to them.
- `src/clients/web/web-transcripts.ts`: the Discord conversation views and `openEngineStream`, the writer for the live event stream.
- `src/clients/web/web-console.ts`: `consoleOptions` reads the `WEB_*` settings. `createConsole` returns the `node:http` server.
- `console/src/`: the app. `events.ts` maps engine events to chat messages. `console/share.html` is the public share page at `/s/:id`.

## Run locally

The console needs these settings:

```dotenv
WEB_ENABLED=true
WEB_ORIGIN=http://localhost:3000
WEB_HOST=127.0.0.1
WEB_PORT=3000
DISCORD_CLIENT_ID=your_discord_application_id
DISCORD_CLIENT_SECRET=your_oauth_client_secret
```

1. Copy `.env.development.example` to `.env.development`. The dev stack reads only that file. It needs a Discord application separate from production, `DATABASE_URL`, `DATABASE_SCHEMA=slopbot_dev` and `SEARXNG_URL`.
2. In the Discord Developer Portal application's OAuth2 settings, register exactly `http://localhost:3000/auth/callback`. Obtain the OAuth client secret from the application settings; it is different from the bot token. Never put it in the frontend.
3. Build the console once with `pnpm -F slopbot-console build`. The bot serves `console/dist`.
4. Run `pnpm run dev`. It compiles in watch mode and runs the bot with `--watch`. With `WEB_OAUTH_BASE=http://127.0.0.1:9091` set, it also runs `scripts/development/dev-oauth.mjs`, a stand-in for Discord sign-in. Any Discord user ID can sign in there, and the bot still checks server membership. The console refuses `WEB_OAUTH_BASE` in production.
5. Open `http://localhost:3000/console`.

To work on the console itself, run `pnpm -F slopbot-console dev`. Vite serves it on port 5174 and proxies `/api` and `/auth` to the bot at `SLOPBOT_URL` (default `http://localhost:3000`).

Production uses an HTTPS origin and matching callback. The Slopbot console is served at `https://slopbot.pmservers.org/console`, with the OAuth callback at `https://slopbot.pmservers.org/auth/callback`. Set `WEB_ORIGIN=https://slopbot.pmservers.org` and `WEB_HOST=0.0.0.0`. Sessions are stored in the database. Each login lasts 30 days from its last renewal, and a restart keeps users signed in. Run one bot process per database.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /auth/login`, `GET /auth/callback`, `POST /api/logout` | Discord sign-in. OAuth state is browser-bound, expiring and single-use. |
| `GET /api/session`, `GET`/`POST /api/settings`, `GET /api/status`, `GET /api/usage` | The signed-in user, settings and usage. |
| `GET /api/conversations/:channel/...` | Discord conversation views, with `?server=`: messages, search, `events` (live), `turns/:turn/events` (saved). The user must be able to view the conversation. |
| `GET /api/chats`, `POST /api/chats`, `PATCH`/`DELETE /api/chats/:id` | Private chats. |
| `GET`/`POST /api/chats/:id/messages` | Read the messages of a chat, and send a message. |
| `GET /api/chats/:id/events` | The live engine stream of a chat. |
| `GET /api/chats/:id/turns/:turn/events` | The saved engine events of one turn. |
| `POST /api/chats/:id/stop`, `POST /api/chats/:id/ui/:card/act` | Stop the replies in a chat, and press a card button. |
| `POST /api/chats/:id/images`, `POST /api/chats/:id/files` and their `GET`/`DELETE` | Attachments of a chat. |
| `/api/chats/:id/shares`, `/api/shares`, `/s/:id` | Share links. `/s/:id` is the public share page. |
| `/api/admin/*`, `POST /api/mcp`, `/api/servers/:server/inbox` | Admin panel, MCP connections and the inbox. |

Other `/api` routes need a session. Writes need the configured Origin and the session's CSRF token.

## Live events

Both live streams send server-sent events with the name `engine`. The `id` is the event's `seq`, and the data is the `EngineEnvelope` as JSON. Chat streams begin with `retry: 3000`.

- A client resumes with the `Last-Event-ID` header or `?after=`. Without either, the stream starts at the newest event.
- The backlog is sent first. Events published during the backlog read wait and are sent after it.
- Only saved events are sent. An envelope without a `seq` is skipped.
- The stream sends `: ping` every 15 seconds. It checks access again when access changes and every 30 seconds. If access is lost, it sends `event: closed` with a reason and ends.

## One turn view for live and saved events

The console turns engine events into chat messages in `console/src/events.ts`. Each request is one `TurnView`, built by `reduceTurn` in `packages/contracts/src/reduce.ts`. Text and thinking deltas join their part. Tool input and status join the tool call with the same `call` ID. `message.upsert` and `message.delete` change the saved messages instead.

A turn is built the same way whether its events arrive live or are loaded from `/turns/:turn/events`. The chat page (`console/src/chat.tsx`) and the Discord conversation view (`console/src/servers/channel.tsx`) both subscribe to the `engine` event. Both load a turn's saved events through the turn route when they need it.

## Private chats

A private chat has the channel `web:<chat id>`. The owner sends a message through `WebChatService.send`. It checks ownership, attachment counts and the usage limit, then saves the message with surface `web` and publishes it. Then it hands the message to the workspace with `ingested: true`. Replies come back through `WebChatGateway`. They are saved and published, and never sent to Discord. Private chats have no reactions and no task threads.

A Discord DM is also a private channel, named `web:dm:<id>`. Its surface is `discord-dm`. So a DM is not offered web visuals such as `show_ui`.

Images and files are kept in object storage when it is configured, and in local storage otherwise. The saved message keeps a placeholder for each attachment: its name, type, size and ID. It never keeps the bytes.

## Scopes

| Scope | Controls | Authority |
| --- | --- | --- |
| Server | Participation monitoring, classifier/reply context, automatic reply limits, timing footers | Manage Server, checked on every invocation |
| Channel | Monitor/unmonitor, history window, older imports, pause/resume/status | Manage Server plus channel visibility/history for user and bot |
| User in server | Personal profile fields, permission for others to edit | Current Discord member; target forced to the signed-in user |
| MCP connections | Add, refresh, disable, remove, credentials, and explicit tool grants | Manage Server, rechecked on every configuration request |
| Operator | Models, providers, tokens, credentials, database | Environment only; secrets never returned |

Reply limits are server policy with independent counters in each channel. There is no invented channel/user override hierarchy. History windows are channel-specific. Profiles are public within the server. Each bot installation currently serves one configured guild; multi-server hosting needs a separate lifecycle design.

Removing a monitored channel uses the existing purge behavior and asks for confirmation in the UI. Context saves are two existing tool calls; if the second fails, the UI reports which part was saved. Operations have server-generated IDs and existing audit records. The browser never supplies its identity or an admin flag.

Sign-in uses browser-bound, expiring, single-use OAuth state. Session cookies are HttpOnly, SameSite=Lax and Secure with HTTPS. Writes require the configured Origin and a per-session CSRF token. Every snapshot checks membership; every invocation re-fetches Discord permissions. API errors avoid provider credentials. The API exposes only the configuration tool allowlist; static file serving uses an allowlist too.

MCP configuration uses a separate authenticated `POST /api/mcp` endpoint, not a model-callable management tool. Configuration is guild-scoped and does not require selecting a chat channel. Only admin snapshots include connection metadata and discovered schemas. Saved bearer tokens are never returned. See [runtime MCP connections](TOOLS.md#runtime-mcp-connections) for supported transports, encrypted credential setup, and execution policy.

## Design

- The console uses React and agentic-ui-kit (0.9.1, from the `catalog` in `pnpm-workspace.yaml`). The kit's defaults come first. Brand choices go only through the kit's theming, in `console/src/theme.css`.
- Dark is the default theme. A local preference can choose light or system (`console/src/prefs.ts`).
- Fonts are bundled in `console/src/fonts/`, with their licenses. Pages allow fonts, scripts and styles from the same origin only (`consoleCsp` in `src/clients/web/routes/static.ts`). The console adds `wasm-unsafe-eval` for code highlighting.
- The logo and brand SVGs are in `share/assets/`.

## Verification

`pnpm test` covers the web client: configuration, OAuth state and cookie binding, unauthenticated access, CSRF and Origin rejection, revoked access, the tool allowlist, logout, static path protection, the engine routes (`tests/engine-routes.test.ts`) and the source boundary (`tests/discord-source-boundary.test.ts`). `pnpm -F slopbot-console test` runs the console tests, and `pnpm -F slopbot-console build` type-checks and builds it. Real Discord OAuth needs configured client credentials and a manual sign-in test.
