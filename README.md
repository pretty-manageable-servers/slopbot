# Slopbot

Discord bot for the [context architecture](architecture/CONTEXT.md). Mentions and replies get fresh answers. `@Slopbot !task <goal>` creates a shared thread with persistent conversation history.

The optional [web configuration console](architecture/WEB_UI.md) provides Discord sign-in and live controls for server participation, monitored channels, history imports and your profile. Its setup and branding sources are documented there.

The marketing copy is at `https://pmservers.org/slopbot`. The configuration console is at `https://slopbot.pmservers.org/` through its dedicated Cloudflare Tunnel.

Requires Node.js 22.13 or later. Test the core without credentials:

```sh
npm install
npm test
npm run demo
```

## Test on Discord, about 10 minutes

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). On its **Bot** page, enable **Message Content Intent** and obtain the bot token. Keep the token in your local .env file.
2. Use **OAuth2 → URL Generator**, select the **bot** scope, and grant **View Channels**, **Send Messages**, **Read Message History**, **Create Public Threads**, and **Send Messages in Threads**. Open the generated URL to invite it to your test server. Use a normal server text channel for the first test.
3. Enable Discord **User Settings → Advanced → Developer Mode**. Copy your server ID and test channel ID using their right-click menus. Run `cp .env.example .env`; fill in `DISCORD_BOT_TOKEN`. To limit Slopbot to some servers, set `DISCORD_GUILD_IDS`. To start with channels already monitored, set `DISCORD_GUILD_ID` and `DISCORD_CHANNEL_IDS`. One bot process serves every server it is invited to; each server has its own settings, channels, MCP connections and workers. Leave `LLM_MODE=mock`.
4. Run `npm start`. Wait for **Slopbot connected**. In the selected channel, send `@Slopbot hello`. Expect **Local reply: hello**. Reply to that bot message without mentioning it; expect another reply. Ordinary unaddressed messages stay silent.
5. Send `@Slopbot !task plan dinner`. Expect a thread and an answer inside it. Write two contributions there from different accounts without pings. Both should get ordered answers. Restart the bot, then write in that thread again; it should continue the stored history.

Mock mode tests Discord wiring, not model intelligence. Its answers echo the latest input.

## Enable your AI provider, about 2 minutes

In .env, set:

```dotenv
LLM_MODE=provider
LLM_BASE_URL=https://api.pmservers.org/ai/v1
LLM_API_KEY=your_key_here
LLM_MODEL=nimbus
```

Restart with `npm start`. The adapter sends streaming requests to `/chat/completions`. The configured model is PMServers’ `nimbus`. Use the exact model ID accepted by the provider. Run `npm run models` to list available IDs when changing models.

Test actual continuity: inside a task thread, say "The budget is $200", then ask "What budget did I give you?" Try the same after a restart. Outside the thread, reply to an older bot answer and ask a follow-up; it should use the reference without continuing that task session.

## Context and memory, about 3 minutes to test

1. Restart with `npm start`. Chat messages are stored and searched in SQL. Saved lessons/memories are embedded in the background using `llama.cpp/embeddinggemma-2`, restricted to the current server and channel.
2. Send `@Slopbot !remember The dinner budget is $200`. This explicitly saves your statement with its author and source message ID. It does not mark it as a group agreement.
3. Ask `@Slopbot What is our dinner budget?` in the same channel. Use `@Slopbot !memory` to inspect saved notes and IDs. Only the note's author can use `@Slopbot !forget <id>`.
4. Edit or delete the source message, then ask again. The saved note and dependent generated messages are removed from future recall. Original reasoning and run logs remain retained as operational records, outside search.
5. Use `/slopbot index channel:<channel> action:window days:30` to import a 30-day window, then `action:more` to extend backwards by up to 5000 messages. `action:status` shows coverage and embedding usage.

Names are linked to stable Discord author IDs. On startup, existing indexed authors are refreshed from Discord; new messages and imports save display names and usernames. Person questions filter sources to that author. Recent corrections from the same requester can resolve a pronoun follow-up. Unknown or ambiguous names ask for a Discord mention. Explicit quote lists are formatted directly from canonical messages without model rewriting. Quote results carry source-message links; they are selected stored evidence, not an exhaustive judgment of everything the person has ever said.

Replies use the referenced message and its stored ancestor chain as their focus. Unrelated recent chat is excluded; explicit history and quote requests can also retrieve memory. Attachment metadata is retained, but media contents are not inspected yet. A question about an image or GIF should say that limitation rather than describe unseen content.

Set `DATABASE_URL` to use PostgreSQL/pgvector. SQLite is available locally. Chat search uses database full-text indexes or SQL keyword matching. Embeddings are reserved for explicitly saved lessons/memories; failures fall back to keyword ranking and can be retried on restart. Opening either database removes the legacy per-message embedding table and its usage counters while retaining chat history and saved memories.

## Participation

`JEV_ENABLED=true` enables `vane` through the provider's native `/decisions` endpoint. This is a decision model, not a text-generating chat model. Native support is documented in the [Bifrost Decisions guide](https://bifrost-1.ghost.io/typesafe-system-one-models-and-new-v1-decisions-endpoint/).

Name requests such as "Slopbot, help me with dinner" can trigger a reply without a ping. Ordinary conversation should stay silent. Explicit mentions and bot replies bypass classification. Unsolicited responses require high confidence and are limited to one per minute and three per hour per channel. Classifier failures remain silent. Mock mode disables network classification and embeddings.

Admins with Manage Server permission can use `/slopbot monitoring`, `/slopbot context`, `/slopbot status` and `/slopbot why`. Monitoring and JEV context settings persist across restarts. Diagnostics are ephemeral and do not appear in ordinary conversation. `JEV_CONTEXT_MESSAGES` and `REPLY_CONTEXT_MESSAGES` configure the independent initial context limits. Configure channels with `/slopbot channels action:add channel:#chat` or ask Slopbot to monitor a channel. Manage Server permission is required. Saved settings override the initial `DISCORD_CHANNEL_IDS` list. Removal immediately stops ingestion and purges searchable content, including dependent task context.

## Current implementation limits

`Application` owns context assembly and routing. `LLM`, `Store` and `Transport` are replaceable TypeScript interfaces. `ChatGateway` isolates Discord operations for testing. Storage operations are asynchronous so remote database adapters can be added without changing the core. `SQLiteStore`, `FakeLLM`, `ChatCompletionsLLM` and `DiscordAdapter` are the current adapters. Incoming messages and provider text chunks are validated at runtime.

Channel requests use fresh prompts with a stable instruction and tool prefix. Task threads retain attributed history, tool calls and results. SQLite queues inputs durably and processes each channel in order, including delivery. Restart recovery reuses saved answers and completed tool results. Unknown external outcomes pause for reconciliation; they are not blindly repeated. A crashed worker's lease can delay recovery by up to 60 seconds.

Long task histories become source-linked JSON checkpoints while original history and all provider-exposed reasoning/opaque events remain stored. Edits and deletes invalidate affected context. `CONTEXT_TOKENS`, `OUTPUT_TOKENS` and `CHECKPOINT_TOKENS` configure budgets. Defaults follow the [PMServers model limits](https://docs.pmservers.org/ai/prompting/): nimbus uses 200,000 total context tokens and 50,000 output tokens; cirrus uses 64,000 and 32,000. Stored checkpoints use 2,048 tokens. Internal decision reports, conversation summaries and file inspections share the configured model output allowance instead of independent low caps. Deployment clears prior context/output overrides so the configured model selects its documented defaults. The current counter uses a conservative byte estimate, not a model tokenizer. Provider-reported usage, including cached tokens when available, appears in `/slopbot status`. Cache hits have been observed with the configured provider; they are not guaranteed.

Tools share one registry with slash commands. Admin permissions apply equally to conversational requests. Write requests move into dedicated task threads, where Slopbot posts tool arguments and results. Available actions include channel settings, history imports, cooldowns, context settings, memory and task recovery. `/slopbot task_status` shows jobs; `/slopbot task_retry id:<job-id>` retries a failed or blocked job after its external result can be reconciled. Discord delivery uses saved intents and nonces; if a prior send cannot be found within the latest 2000 messages, it remains blocked instead of risking a duplicate.

Try: “Slopbot, set cooldown to 120 seconds and 5 replies per hour.” An admin request should create a thread, perform the action and report its result. Then try “Slopbot, index the last 150 days in #chat.” Add connectors through the [tool extension guide](architecture/TOOLS.md); they automatically appear in the model catalog and command interface.

Admins can add remote MCP servers in the web console's **MCP connections** tab while Slopbot is running. Discover tools, select which to enable, and assign access and read/write policies without redeploying. Connections persist across restarts. For bearer-authenticated servers, configure `MCP_SECRET_KEY` once to encrypt saved tokens. See [runtime MCP setup and limits](architecture/TOOLS.md#runtime-mcp-connections).

GIF fixes and cross-channel/project memory remain to implement. Storage supports SQLite locally and PostgreSQL/pgvector in deployment. Run one bot process per database; this is not a distributed worker deployment. Only configured channels and registered task threads are read. No DMs.

Configure unsolicited replies with `/slopbot cooldown seconds:120 per_hour:5` using Manage Server permission. Changes apply immediately and persist across restarts. Each channel has separate counters. Mentions, replies and recognized name requests bypass these limits. `seconds:0` removes the interval; `per_hour:0` disables unsolicited replies. Counters reset on restart.

`.env` defaults are `JEV_COOLDOWN_SECONDS=60` and `JEV_MAX_REPLIES_PER_HOUR=3`. Saved slash-command settings override these defaults. `/slopbot status` shows the active limits.

History imports run in the background for configured text channels. On startup, Slopbot fills the last `HISTORY_WINDOW_DAYS` days, default 7, then catches up from its last completed scan. New messages save live. Every minute it checks for gaps; unfinished imports resume after restart. Separate thread histories are not imported automatically.

Web transcript live events are kept for `CONVERSATION_EVENTS_RETENTION_DAYS` days, default 14, and at most `CONVERSATION_EVENTS_MAX_ROWS` rows, default 2000000. Slopbot prunes them at startup and every hour. Saved runs stay viewable after their live events are pruned; a browser whose stream position was pruned reloads the conversation.

- `/slopbot index channel:#chat action:window days:30` sets initial coverage to 30 days.
- `/slopbot index channel:#chat action:more` imports up to 5000 messages before the oldest imported message. Repeat to reach the beginning.
- `/slopbot index channel:#chat action:status` shows stored dates, message/saved-memory vector counts, import progress and successful embedding requests/reported tokens, separated by indexing and queries.
- `/slopbot index channel:#chat action:pause` pauses history import after the current page; `action:resume` continues. Live message ingestion continues.

The window controls import coverage, not deletion or prompt size. Older imported text remains saved. Messages are deduplicated; saved memory vectors for the same model are reused. Usage starts being counted with this version, includes edits/retries that succeed, and marks requests without provider token counts as unknown. Failed requests may still be billed by the provider and are not included. No currency estimates are made. These commands require Manage Server permission.

## People and profiles

Profiles use stable Discord user IDs and are public within the configured server. Discord handles, display names, server nicknames and server names refresh automatically. Real names and other custom fields are added explicitly; the bot does not infer personal facts from jokes or guesses. Names replace known bare author IDs in ordinary output; message links and mentions remain intact.

- `/slopbot profile action:get` posts your current profile publicly; `user:@person` selects another member.
- `/slopbot profile action:set user:@person field:real_name value:"Oscar"` adds a JSON value. Use fields such as `nicknames`, `github`, `interests` or a new field of your own. Arrays use JSON syntax, e.g. `["Rice Farmer", "Oscar"]`.
- `/slopbot profile action:lock allow_edits:false` prevents others editing your profile. Other members may edit by default; their contributions remain attributed and unconfirmed.
- `/slopbot profile action:history` privately lists your revisions; `action:undo revision:<id>` restores the previous valid value. Only the owner can undo; a newer edit must be undone first.
- Ask conversationally: “Slopbot, add Oscar as a nickname for @RiceFarmer.” The same permission checks and edit journal apply. Writes run in a task thread.

Current custom fields are scoped to this server. There is no automatic sharing across servers. Edits/deletes to supporting messages invalidate the associated profile entries. Profile aliases participate in exact name lookup; ambiguous names require a mention. The profile storage interface supports asynchronous database adapters.

### Files

Upload a file and ask `@slop summarize this file`, or reply to an attachment and ask about it. The model can call `file_read`; members can also use `/slopbot file_read message_id:<id> question:<question>`.

With object storage configured, ask `@slop save this attachment as receipts/october.pdf`, `list my saved files`, `summarize my stored receipts/october.pdf`, or `send my saved file back to me`. The `file_store` tool defaults to private personal files within the current server and can DM the original bytes back. You can also save generated sandbox files and load stored files into the task sandbox.

Ask `publish my reports/result.csv` to make it discoverable in this server's public file library and get an expiring download link. Other members can inspect or copy published files using the owner's Discord ID. `unpublish` makes it private again; existing download links remain usable until expiry. Replacing a file requires explicit overwrite; personal replacements are private, and server replacements are shared. `list public files` browses shared files. Stored files have a 10 MiB limit.

Choose `storage_scope:user` for personal files that follow you across permitted servers, `storage_scope:server` for a shared server directory, or `storage_scope:user_server` for your own directory within this server, the default. Members can upload new server paths; only a file's creator or a server admin can replace, publish/unpublish or delete it. Personal files remain owner-controlled even from admins. Server uploads default to shared; unpublishing restricts them to the creator and admins. `copy` supports `destination_scope` to transfer between these directories. Publishing a global personal file makes it discoverable across permitted servers; server-scoped publication stays within the current server.

Set `OBJECT_STORAGE_BUCKET` and a bucket-scoped read/write `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`; PMServers uses `https://s3.pmservers.org`, region `pms`, and path-style S3. See [storage setup](architecture/DEPLOYMENT.md#object-storage-configuration). `npm run storage:smoke` verifies the configured service with a temporary binary upload and signed download.

Supported: UTF-8 text/code, JSON, CSV, PDF text, DOCX, XLSX, PNG, JPEG, WebP, AVIF, TIFF and GIF. GIFs supply up to five ordered frames to the configured vision-capable model. File inspection has a stable prompt prefix and retains provider reasoning events. Results link to the source message.

Limits: 10 MiB download, 20 seconds decoding, 16 million pixels per image, 16,000 extracted characters and the first 20 PDF pages. Scanned PDFs require text/OCR from elsewhere; audio, video and legacy DOC/XLS are unsupported. Files are inspected on demand, not automatically during history indexing or JEV participation checks. Only sources in the requester's permitted channel can be inspected.

To add a format, implement `FileReader` and register it in `defaultFileReaders()` in `src/adapters/file-readers.ts`. Download, decoding and LLM interfaces are separate.

Dependency audit: three moderate findings remain in Mammoth's CLI dependency chain (`argparse` / `sprintf-js`); no patched `sprintf-js` release is available. The bot uses Mammoth's raw-text API in an isolated worker, not its CLI.

The core module boundaries and prioritized follow-up work are documented in [architecture/IMPLEMENTATION.md](architecture/IMPLEMENTATION.md).

### Web search

`web_search` is shared by the model and `/slopbot web_search query:<query>`. It returns titles, URLs and snippets. The implementation uses SearXNG, matching [Housebot's current search adapter](https://github.com/bushshrub/housebot/blob/master/crates/tools/src/searxng.rs). It does not fetch full pages.

If you already have an instance, set `SEARXNG_URL` in `.env`; enable JSON in its search formats. Without an instance, start Docker Desktop and run:

```sh
npm run search:start
```

This generates local settings with a random secret and starts SearXNG on localhost port 8080. Then add `SEARXNG_URL=http://127.0.0.1:8080` to `.env`, restart with `npm start`, and try `/slopbot web_search query:TypeScript`. Stop the search service with `npm run search:stop`.

Without `SEARXNG_URL`, the tool reports that configuration is needed. Local startup requires a running Docker daemon; live search has not been verified in this environment because Docker is stopped.

The agent lifecycle follows [Auger's state machine](architecture/HARNESS.md), adapted to Slopbot's durable requests, permissions and tool journal.

## Deployment

See [managed deployment](architecture/DEPLOYMENT.md).

Tool definitions are sent as native chat function schemas. Results use matching tool-role messages; provider IDs and completed operations survive recovery. `MAX_TOOL_ROUNDS` defaults to 64 new rounds per attempt and accepts 1-1000. Retrying a job gets a fresh allowance without rerunning completed operations.

Errors in replies, jobs, failed runs, web responses and background logs use shared diagnostics with the actual reason, code, failing stage and available request IDs. Credentials are redacted. `bot_info topic:errors` explains recovery. `bot_info topic:pmservers` and `topic:pmservers_changelog` summarize the PMServers docs reviewed on October 12, 2026; runtime and capabilities report the bot's current safe configuration and tools. Vane classification uses the documented System One endpoint.

Task history reserves space for tool calls/results before packing. Active loops checkpoint older completed work before the input budget fills, preserving the current request, latest complete native tool batch and all original journal records. Recovery rebuilds checkpoints and reuses saved tool results. A genuinely oversized call reports CONTEXT_BUDGET with estimated input-unit figures instead of UNEXPECTED_ERROR.

### Deployment changelogs

After the PMServers deployment succeeds, GitHub Actions posts through the `SLOPBOT_CHANGELOG_WEBHOOK_URL` repository secret. The destination is fixed to `#slopbot-changelog` in server `1528063444874432734`, channel `1559233255763353600`, independently of the servers where Slopbot operates. The webhook is never stored in source code or supplied to the model.

Add a short Markdown file under `changelog/` with each user-visible change. Announcements collect added or updated notes since the last confirmed announcement, or use commit titles if no notes exist. They link to the deployed version, comparison and workflow, and disable mentions. The first announcement starts after commit `3ac2ea9`.

GitHub deployment records in the `slopbot-changelog` environment track delivery. Confirmed versions are not posted again. A definite Discord rejection is marked failed and can retry; a timeout, server error or lost confirmation leaves a reservation to avoid duplicate messages. For `CHANGELOG_DELIVERY_UNCERTAIN`, inspect the channel and the referenced GitHub deployment. Mark its status `success` if the message exists, or `failure` only after confirming it was not delivered, then retry the workflow. Notification failures appear in the separate announcement job; the successful application deployment remains visible.

Source changes now report `CONTEXT_CHANGED` with a reason and source ID. Live tool status, refreshed Discord attachment signatures and automatic previews do not invalidate active plans. Imported edits update canonical sources, with older revisions rejected. Native and envelope tool batches share a 64-call bound. See the [error audit](architecture/ERROR_AUDIT.md) for root causes and regression reproduction.
