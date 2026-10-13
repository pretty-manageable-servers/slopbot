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
| Rate limits | One per-user limit for all input. A web reply cannot get around it (see below). |
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

1. **One gate.** Add `UserLimiter` and call it in `TaskWorker.enqueue` (`src/queue.ts`) before `enqueueJob`. Every run goes through this path: Discord messages, slash commands and web replies.
2. **Key** by server ID and Discord user ID. Store the counters in Postgres so that restarts and more workers share them.
3. **Limits by plan** (Seed, Bloom, Garden). Start with one setting for each server, and link it to the plan later.
4. **Check before posting.** The web reply endpoint calls `UserLimiter.check` before it posts the webhook message. If the user is over the limit, nothing is posted, and the web shows "Limit reached" with the reset time. The queue gate checks again, so a race cannot get past it.
5. **Webhook messages are not trusted by themselves.** See the next section.

## Web replies through a webhook

- Slopbot makes one webhook for each turned-on channel (for a thread, the webhook of the parent channel with `thread_id`). It keeps the webhook token secret, encrypted at rest.
- Post flow:
  1. Check the permission, the limit and the size (Discord limit: 2000 characters).
  2. Make a row in `web_replies` (id, server, channel, user ID, text hash, status `pending`).
  3. Post with `username` = the server display name, `avatar_url` = the user's avatar, `allowed_mentions` = none by default, and `wait=true` to get the message ID.
  4. Save the message ID in the row.
- In `src/adapters/discord.ts`, when a message has `webhookId`:
  - If the webhook is Slopbot's and the message ID (or the pending row, if the message comes first) matches a `web_replies` row, change the message: `author` = the real user ID, `isBot` = false, `addressed` = true, and mark `source: "web"`.
  - In all other cases, keep the message as `isBot` as it is now. A leaked webhook URL or another bot's webhook cannot act as a user.
- The changed message then goes through the normal path. It gets the user's permissions, file storage scope, admin status and rate limit.
- Discord shows a "BOT" or "APP" tag on webhook messages. This is a Discord limit and cannot be changed.

## Live streaming

- New endpoint: `GET /api/conversations/:channel/stream` (SSE). It sends:
  - `message`: new, edited or deleted Discord messages.
  - `run.start`, `run.delta` (text and thinking tokens), `run.tool` (tool name, status and arguments in short form), `run.end`.
- Source: add a small in-process publisher next to `EventJournal.append`. It sends each event to subscribers at the same time as it saves it. Do not change how the journal saves events.
- Smooth display: the browser puts deltas in a buffer and shows them in small steps with `requestAnimationFrame`. It goes faster when the buffer grows, so it does not fall behind.
- Reconnect: SSE `Last-Event-ID` = journal sequence. On reconnect, send the events after that ID from the store.
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
| Tables | `web_replies`, `shares`, `user_limit_counters`, channel setting `web_transcripts` |

## Steps (one PR each)

1. `UserLimiter` in the queue, with tests. Useful without the web.
2. Channel switch for admins, and `channel-access` permission checks.
3. Read-only transcript and history API, and the web view.
4. Live SSE stream and the smooth display.
5. Web replies through a webhook, with tests for webhooks from other sources and for limits.
6. Share links (admins only).

## Tests

- A user over the limit: Discord messages, web replies and slash commands are all refused.
- A web reply when over the limit: the webhook message is not posted.
- A message from another webhook or a leaked webhook URL: treated as a bot, no run.
- Channel permission removed: the next read returns 403, and the stream closes.
- Channel turned off: no list entry, no stream, no reply.
- A snapshot does not contain tool results, cost, user IDs or later messages.

## Open questions

- Limit numbers for each plan.
- Should the thinking text show for all members in the live view, or only for admins?
- One webhook for each channel, or one for each server with channel moves?
