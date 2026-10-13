# Plan: web transcripts and web replies

Status: plan only. No code yet.

Discord stays the main way to use Slopbot. This plan adds a web view in the console (`slopbot.pmservers.org`). In it, a user can:

- See the transcript of a channel or thread live.
- Open each Slopbot reply to see its run: streamed text, thinking and tool calls.
- Send a reply from the web. It shows in Discord as the user.

Slopbot is shared work. Keep each step a small PR. Add new files, and do not rewrite existing ones. Touch `src/adapters/discord.ts`, `src/queue.ts` and `src/web-console.ts` only where the steps below say to.

## Words

- **Conversation**: one Discord channel or thread. Task threads (`startTask`, `handoff.threadId`) are their own conversations.
- **Run**: one Slopbot answer. The `EventJournal` (`src/event-journal.ts`) already saves its model events by `runId`.

The web shows a conversation as a list of messages. A Slopbot message has a "show run" toggle that opens its run.

## Decisions

| Topic | Decision |
|---|---|
| Who can see | Discord members with live **View Channel** and **Read Message History** permissions in that channel. |
| Which channels | Only channels a server admin turns on in the console. Off by default. |
| Web replies | Allowed. Posted through a channel webhook with the user's display name and avatar. The user must have live **Send Messages** permission (**Send Messages in Threads** for threads). |
| Web reply answers | A web reply always gets an answer. It skips the participation (JEV) check. |
| Rate limits | Per-user limits by API cost, in a 5-hour window and a weekly window. One gate for all input. A web reply cannot get around it (see below). |
| Admin panel | A separate console section for members of the Discord Developer Portal team that owns the bot. The Read-only role can only view. |
| Run detail | Tool calls, thinking and streamed tokens. No cost. |
| Live | Tokens stream with SSE and show smoothly. |
| History | Old conversations and runs can be listed and searched. |
| Share links | Built now, but only admins can make them. A share link is a frozen snapshot. |

## Login and permissions

- Use the Discord login that is in the console now. The session gives the Discord user ID.
- On each read and each send, check the user's permissions in that channel with the bot's Discord client: the guild member, then `channel.permissionsFor(member)`. Cache the result for no more than 30 s, and clear it on Discord `guildMemberUpdate`, `channelUpdate` and `guildMemberRemove` events.
- If the check fails, return 403, close open SSE streams for that channel, and remove the channel from the list.

## Admin channel switch

- New setting for each channel: `web_transcripts` (on or off). Store it with the other server settings.
- Show it in the console channel list. Only server admins can change it, with the same check as the other admin settings.
- When an admin turns it off, close live streams and stop web replies. Saved history stays, but it is hidden.

## Rate limits (must not be bypassed)

There is no per-user limit today. Explicit requests skip the unsolicited cooldowns (`src/participation.ts`, `/status`). This plan adds one limit for everything.

1. **One gate, every entry point.** Add `UserLimiter.consume(server, user)`. Call it in each place where user input starts work:
   - `TaskWorker.enqueue` (`src/queue.ts`) before `enqueueJob`: Discord messages and web replies.
   - The slash command handler (`src/adapters/discord.ts`) before `tools.invokeResult`. Slash commands call tools directly and do not use the queue.
   - Any new entry point must call it too. A test lists the entry points and fails if one does not call it.
2. **Key** by server ID and Discord user ID. Store the counters in Postgres so that restarts and more workers share them.
3. **Limit by API cost, not by request count.** Each LLM call for a user's run adds its cost to that user. `src/usage-cost.ts` changes the provider usage (input, cached input and output tokens) into cost with a price table for each model. An unknown model uses a fallback price, never 0.
4. **Two windows.** A 5-hour window and a weekly (7-day) window. Each window starts at the user's first request after the last window ended. New work starts only if both windows are below their limits.
5. **Wrap-up allowance.** A run that started below the limit can finish. If the run goes past the limit plus the grace percent (default 10%), it starts no new tool rounds and writes a short final answer. A reply is never cut while it streams.
6. **Banked resets.** Admins give a user resets for the 5-hour or the weekly window. A user sees their usage and uses a reset with the `usage` tool. Using a reset clears that window and takes one reset from the bank, in one atomic step.
7. **Numbers in the admin panel.** Limits, grace percent and model prices are settings. The defaults are placeholders. Later the limits link to the plans (Seed, Bloom, Garden).
8. **Check before posting.** The web reply endpoint calls `UserLimiter.check` before it posts the webhook message. If the user is over the limit, nothing is posted, and the web shows "Limit reached" with the reset time. The queue gate checks again, so a race cannot get past it.
9. **Webhook messages are not trusted by themselves.** See the next section.

## Team admin panel

- A separate admin section in the console.
- Access: the bot gets its application with `client.application.fetch()`. The application owner is the Developer Portal team. A logged-in user whose Discord user ID is a team member can open the panel. Check by user ID only, never by email.
- Roles: Owner, Admin and Developer can change things. Read-only can only view.
- Load the team again every 5 minutes. A removed member loses access within that time.
- Contents: limits, grace percent and model prices; usage of each user, with reset and "grant banked resets" (5-hour or weekly); channel switches and share links for all servers.

## Web replies through a webhook

- Slopbot makes one webhook for each turned-on channel (for a thread, the webhook of the parent channel with `thread_id`). It keeps the webhook token secret, encrypted at rest.
- Post flow:
  1. Check the permission, the limit and the size (Discord limit: 2000 characters).
  2. Make a row in `web_replies` (id, server, channel, user ID, status `pending`).
  3. Post with `username` = the server display name, `avatar_url` = the user's avatar, `allowed_mentions` = none by default, and `wait=true` to get the message ID.
  4. Save the exact message ID that Discord returns in the row, and set status `posted`.
- Identity uses **only the exact message ID** that the webhook post returns. Do not match by text, hash, author name or time. If the webhook token leaks, someone can post the same text, but they cannot get the message ID that Slopbot's own post returns.
- In `src/adapters/discord.ts`, when a message has `webhookId`:
  - If the webhook is Slopbot's and a web reply post is in progress for that channel, keep the event in a buffer (max 10 s). Discord can send `messageCreate` before the post returns.
  - When the post returns, take the buffered event with that exact ID and change it: `author` = the real user ID, `isBot` = false, `addressed` = true, `source: "web"`. Handle all other buffered events as bot messages.
  - If the post fails or the time ends, handle the buffered events as bot messages and mark the row `failed`.
  - In all other cases, keep the message as `isBot` as it is now.
- If a webhook token leaks, delete and make the webhook again.
- The changed message then goes through the normal path. It gets the user's permissions, file storage scope, admin status and rate limit.
- Discord shows a "BOT" or "APP" tag on webhook messages. This is a Discord limit and cannot be changed.

## Live streaming

- New endpoint: `GET /api/conversations/:channel/stream` (SSE). It sends:
  - `message`: new, edited or deleted Discord messages.
  - `run.start`, `run.delta` (text and thinking tokens), `run.tool` (tool name, status and arguments in short form), `run.end`.
- Source: add a small in-process publisher next to `EventJournal.append`. It sends each event to subscribers at the same time as it saves it. Do not change how the journal saves events.
- Smooth display: the browser puts deltas in a buffer and shows them in small steps with `requestAnimationFrame`. It goes faster when the buffer grows, so it does not fall behind.
- Cursor: journal sequence numbers start at 0 for each run, so they cannot be the cursor. Give each event sent on a conversation stream a `stream_id` that only goes up for each channel (a Postgres sequence in a `conversation_events` table that points to the message or to the run event). SSE `Last-Event-ID` = `stream_id`.
- Reconnect: send all events with a `stream_id` after the cursor, across runs and Discord messages, then continue live.
- More than one bot process: start with one process. If we add more, use Postgres `LISTEN/NOTIFY` for the publisher.

## History and search

- `GET /api/conversations`: the channels and threads that the user can see now, newest first.
- `GET /api/conversations/:channel/messages?before=`: one page of messages from the history store.
- `GET /api/runs/:runId`: the saved events of a run.
- Search uses the history search that exists now, filtered to channels the user can see.

## Share links (admins only for now)

Other AI apps (ChatGPT, Claude.ai, Gemini) all use frozen snapshots that can be deleted and are not indexed. We do the same:

- An admin makes a link from a conversation or a range of messages. The server copies the content to a `shares` row. Later messages are not added.
- What it contains: message text, Discord display names, tool names with short status lines, and Slopbot answers.
- What it leaves out: user IDs, avatars (setting, off by default), tool results, cost, thinking (setting, off by default), and attachments (shown as a placeholder only).
- Link ID: 128 random bits. The page has `noindex` and no login.
- An admin can remove one link, or all links in a server. A removed link returns 404.
- Code it so that the "admins only" rule is one check, and other roles can be added later.

## Where the code goes

| Part | File |
|---|---|
| User limit | `src/user-limiter.ts` (new), called from `src/queue.ts` |
| Web replies and webhooks | `src/web-replies.ts` (new), small hook in `src/adapters/discord.ts` |
| Live events | `src/run-events.ts` (new), one call from `src/event-journal.ts` |
| Permissions | `src/channel-access.ts` (new) |
| API routes | `src/web-console.ts`, with new handlers in `src/web-transcripts.ts` |
| Web UI | `web/` (transcript view, run panel, reply box) |
| Tables | `web_replies`, `shares`, `user_limit_counters`, `conversation_events`, channel setting `web_transcripts` |

## Steps (one PR each)

1. Cost limits (5-hour and weekly), wrap-up allowance, banked resets and the `usage` tool, with tests. Useful without the web.
2. Channel switch for admins, and `channel-access` permission checks.
3. Team admin panel.
4. Read-only transcript and history API, and the web view.
5. Live SSE stream and the smooth display.
6. Web replies through a webhook, with tests for webhooks from other sources and for limits.
7. Share links (admins only).

## Tests

- A user over the limit: Discord messages, web replies and slash commands are all refused.
- A web reply when over the limit: the webhook message is not posted.
- A message from another webhook or a leaked webhook URL: treated as a bot, no run.
- A leaked token posts the same text before the real post returns: only the message with the returned ID gets the user identity.
- `messageCreate` comes before the webhook post returns: the event is kept in the buffer and then matched.
- Slash commands over the limit: refused before the tool runs.
- Cost from usage tokens matches the price table. An unknown model uses the fallback price.
- A run past the limit plus grace starts no new tool rounds and still sends a final answer.
- A banked reset clears only its window and takes one from the bank. Two resets at the same time use two from the bank.
- A Read-only team member cannot change settings. A user who is not in the team cannot open the panel.
- SSE reconnect across two runs and Discord messages: no event is lost or sent twice.
- Channel permission removed: the next read returns 403, and the stream closes.
- Channel turned off: no list entry, no stream, no reply.
- A snapshot does not contain tool results, cost, user IDs or later messages.

## Open questions

- Limit numbers and model prices (set later in the admin panel).
- Should the thinking text show for all members in the live view, or only for admins?
- One webhook for each channel, or one for each server with channel moves?
