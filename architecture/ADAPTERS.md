# Engine and clients

Slopbot has an engine and clients. The engine runs requests for each Discord server: context, the model and tool loop, saved state and the engine event stream. It does not know about Discord or HTTP. The clients connect it to the outside world. The Discord client holds the Discord connection. The web client is the HTTP app that serves the console and its API. `src/discord-main.ts` is the composition root. It builds the Discord client, the private chat service, the transcript routes and the console, then starts them. See [implementation boundaries](IMPLEMENTATION.md) for the modules inside the engine.

| Module | Owns |
| --- | --- |
| `src/engine/api.ts` | The interfaces that engine and clients share: `Engine`, `Workspace`, `EngineEventLog` and `Directory`. `surfaceOf` gives a message's surface. |
| `src/engine/engine.ts` | `WorkspaceEngine`: one `Workspace` per open server. A client adds it when the server opens and removes it when the server closes. |
| `src/engine/workspace.ts` | `EngineWorkspace`: one server's state and services. Its calls are `submit`, `stop`, `act`, `openChat` and `closeChat`. It builds the bot and the tool registry. |
| `src/engine/ports.ts` | `WorkspacePorts`: what the engine needs from its platform. These are the directory, delivery (`gateway`), channel checks, message and history fetches and tool registration. |
| `src/engine/event-log.ts` | `EventLog` (`engineEvents`): checks, saves and sends engine events. |
| `src/clients/discord/discord.ts` | `DiscordAdapter`, one per process, with `engine` and `directory`. `DiscordServer`, one per server, builds that server's `WorkspacePorts` and owns its `EngineWorkspace`. The other files in `src/clients/discord/` hold commands, voice, UI interactions, tool progress and web-reply webhooks. |
| `src/clients/web/` | The HTTP app (`app.ts`), its routes (`routes/*.ts`), the request environment (`env.ts`), body reading (`body.ts`), the private chat service (`web-chats.ts`) and the transcript routes (`web-transcripts.ts`). |
| `packages/contracts` | `@slopbot/contracts`: the event and envelope schemas, `reduceTurn`, surfaces and capabilities, and share types. The engine, both clients and the console import it. |

## Rules

- The engine imports no client, no `discord.js` and no `node:http`. The clients do not import each other. `tests/discord-source-boundary.test.ts` checks both rules.
- The engine gets authority from `Directory`: membership, Manage Server and names. It gets platform actions from `WorkspacePorts`, which `DiscordServer` supplies.
- A web chat's message is saved by the chat service before `Workspace.submit(message, { ingested: true })`. The engine does not save it again.
- Clients set `Message.surface`. A saved message without one gets its surface from its channel.

## Surfaces and capabilities

A message comes from one of three surfaces: `discord` (a server channel or thread), `discord-dm` (a Discord DM) or `web` (a web chat). `SURFACE_CAPABILITIES` in `packages/contracts/src/surface.ts` lists what each one can show or do.

| Surface | Capabilities |
| --- | --- |
| `discord` | `discord_actions` |
| `discord-dm` | none |
| `web` | `web_visuals`, `live_tool_input` |

A tool lists the capabilities it `needs`. The model is offered a tool only when the message's surface has all of them, and a call that still arrives is refused with the matching text (`src/tools.ts`). So a DM is not offered `show_ui` or `show_widget`, and a web chat is not offered Discord actions.

## Engine events

Each conversation has one stream of engine events. `packages/contracts/src/events.ts` defines them:

- `turn.start` and `turn.end` bracket one request. `turn.end` is `done`, `failed` or `interrupted`.
- `round.start` begins one model round. `text.delta` and `thinking.delta` carry streamed text.
- `tool.input` carries a call's arguments as they stream. `tool.status` reports a call as running, completed, rejected, failed or delegated, with its reason, parent call and duration.
- `message.upsert` and `message.delete` change a message in the conversation.

`EngineEnvelope` wraps an event with its `conversation`, its time `at` and its `seq`. The `seq` is set only when the event was saved.

`EventLog.publish` checks the event against the schema and queues it. Queued events are saved and sent in publish order. Consecutive text or thinking deltas of one run, and consecutive `tool.input` of one call, are saved as one row. Subscribers still get each delta as it was published.

A web chat's events are always saved. Other conversations are saved only while their transcript switch is on. A thread uses its parent's switch. An event that is not saved reaches in-process listeners without a `seq`. Clients do not see it, and it is not replayed.

Listeners subscribe to one conversation, or to every envelope through `listen`. The Discord client uses `listen` for tool progress. `DiscordServer` shows the `tool.status` events of its own server as Discord status messages (`src/clients/discord/discord.ts`).

Saved rows go to the `engine_events` table, with a `seq` per row. The table exists in SQLite and Postgres (`src/adapters/sqlite.ts`, `src/adapters/postgres-schema.sql`). Rows older than `CONVERSATION_EVENTS_RETENTION_DAYS` (14 by default) and rows beyond `CONVERSATION_EVENTS_MAX_ROWS` (2,000,000 by default) are pruned at startup and every hour. The `conversation_events` table is kept but nothing writes to it.

Events are published by the helpers in `src/run-events.ts` and by `Application` for `turn.start` and `turn.end`.
