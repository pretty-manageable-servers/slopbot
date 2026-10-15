# Scheduled tasks

Members can schedule work in an enabled channel. A schedule runs once, or on a recurring cron schedule.

## Kinds

A run has one of three kinds:

- `message`: the bot posts saved text. No model is used.
- `prompt`: the bot runs the saved prompt as if the owner sent it in the channel.
- `tool`: the bot runs one saved tool call. No model is used. The tool cannot be `schedule` or `reminder`. Access is checked again as the owner at each run.

## Timing

- A one-time schedule uses an ISO time with `Z` or an offset. It must be in the future and at most 30 days ahead.
- A recurring schedule uses 5 cron fields and an IANA timezone, for example `0 9 * * 1` and `Europe/London`.
- The minimum gap between runs depends on the kind. The defaults are 15 minutes for `message` and 60 minutes for `prompt` and `tool`. The admin panel can change them.

## Limits

- The admin panel sets one cap per server and one cap per user. The defaults are 50 for each server and 10 for each user.
- Active, running and paused schedules count toward the caps.

## Expiry

- Every user is on the free plan. A recurring schedule expires 30 days after it is created or renewed.
- The owner or a team editor can renew a schedule with the schedule tool. An expired schedule becomes active again when it is renewed.
- When a schedule expires, the bot posts one note in the channel.

## Pauses

- If the owner is over the usage limit, the bot posts one note and pauses the schedule. Message runs do not use the usage check.
- After 3 failed runs in a row, the schedule pauses and the bot posts one note.
- If Discord reports that the channel is missing or the bot cannot post there, or the channel is disabled, the schedule pauses without a retry.
- A paused schedule does not run until the owner resumes it.

## Restarts and missed runs

Schedules are stored as app records, so they survive a restart. There is no catch-up. After downtime, a missed schedule runs once, and then it waits for its next slot.

## Code

- `src/schedules/schedule-types.ts`: constants and types.
- `src/schedules/schedule-time.ts`: validation and next-run times.
- `src/schedules/schedule-tool.ts`: the `schedule` tool.
- `src/schedules/schedule-worker.ts`: one worker for each server. It starts and stops with the Discord adapter.
- `src/adapters/discord.ts`: wiring. A message run is posted with the owner mention allowed.
