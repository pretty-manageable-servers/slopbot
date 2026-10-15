# Schedule tasks in channels

Members can schedule a one-time or recurring task in an enabled channel with the `schedule` tool. A run can post saved text, send a saved prompt as the owner, or run one saved tool call without the model. Recurring schedules use 5-field cron and an IANA timezone.

Recurring schedules expire 30 days after they are created or renewed. A schedule pauses when the owner is over the usage limit, after 3 failed runs in a row, or when the channel is disabled or the bot loses access. Schedules survive restarts, and a missed run is not repeated.

Caps per server and per user, and the minimum interval for each run kind, are set in the admin panel.
