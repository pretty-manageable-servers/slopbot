# Reduce avoidable diagnostic blocks

Timing and interaction inspections without a usable reply target return guidance, including the exact `message_id` argument to supply. A task-thread anchor without saved timing also returns a normal unavailable result. Explicit invalid interaction IDs name the argument and accepted target.

Operators can count `TOOL_BLOCKED`, `TOOL_FAILED`, `TOOL_ROUND_LIMIT` and `CONTEXT_BUDGET` events by day and tool from exported NDJSON logs:

```sh
node scripts/development/error-counts.mjs --since 2026-10-14 --until 2026-10-15 --server SERVER_ID < exported-logs.ndjson
```

The command accepts native error lines and timestamped log envelopes. Counts cover the supplied export, with agent failures lacking a tool grouped separately. Undated legacy errors are reported separately. New structured errors include an ISO timestamp. No prompt or log body text is emitted in the counts.
