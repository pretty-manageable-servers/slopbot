# Request timing

The current collector uses request-scoped async context and instruments actual
await boundaries rather than attributing all time inside a broad function to one
service. Broad stage totals remain useful but can overlap. The wall-clock ledger
partitions elapsed time into disjoint intervals: a database wait, a provider read,
a queue wait, concurrent outstanding awaits, or application/uninstrumented.
These buckets add up to the measured total, before display rounding.

Postgres records connection-serialization wait separately from query execution,
using operation/table labels without SQL, parameter values or credentials. Model
HTTP headers and stream reads, decision endpoint, search, embeddings, resource
locks and Discord delivery have dedicated labels. An async provider wait includes
network/server delay and event-loop scheduling; it does not reveal GPU work.

`timing_active` shows other active requests in the current permitted channel.
`timing_inspect view:timeline` reads retained intervals, ten at a time, using
`offset` for pagination. A process-local watchdog emits content-free
`request_wait` logs every 15 seconds for requests older than ten seconds with
active work. This works even when all workers are occupied; the Discord tool may
itself need to wait for a worker. Watchdog sampling pauses if the JS event loop is
blocked. Unknown synchronous work remains explicitly uninstrumented.

Detailed timelines retain the last 256 intervals; aggregate buckets are bounded
to 128 label combinations with further combinations grouped explicitly. Snapshot
flags report truncation. Final records persist these measurements. Old records
remain readable but cannot retroactively identify missing waits.

`/slopbot timing enabled:true` adds a compact timing footer to responses in this
server. It requires Manage Server permission. Use `enabled:false` to disable it.
The setting is persisted and defaults to off. The LLM can invoke the same tool.
If Discord offers only the generic command, use `/slopbot run tool:timing
arguments:{"enabled":true}`.

Timers use a monotonic clock, retain no message contents and need no external
service. They measure reference fetching, participation checks, queue wait,
context building, model streaming and each tool's execution. Repeated model and
tool rounds are accumulated; first model output is recorded per call and includes
reasoning or tool output, not only visible text. Model time includes stream event
journaling. Checkpoint model time is nested within context building, so steps are
not always additive. Uninstrumented validation/storage and scheduling contribute
to total time.

Tool activity also records duration per individual invocation. `timing_inspect` shows it.
Progress updates and reply footers show counts and failed or blocked calls, not durations.
Repeated timed calls remain separate.
This covers the tool executor, including authorization and resource wait, but not
status-message delivery or subsequent result journaling. Replayed results are
marked saved without inventing their original execution time. These durations
are part of the overall timing, not extra time to add again.

The footer uses `Total time` with a before-delivery qualifier and pipe separators.
`other` covers uninstrumented work and any stages omitted from the compact footer.
Checkpoint streaming is counted within context rather than shown twice. First
output is labelled as within model time. Display rounding can leave small differences.
The footer explicitly ends before delivery. The Discord adapter logs a JSON
`request_timing` record keyed by incoming message ID, with delivery duration and
full total after sending. Delivery includes rendering, journaling, Discord API
calls and status cleanup. It measures API completion, not when a user's client
displays the message. Footer text is frozen in the existing database record system
to avoid conflicting with delivery recovery.

Measurements are process-local, capped at 256 active traces with a two-hour
expiry. Restarted/recovered jobs are marked partial; previous process time cannot
be reconstructed. Retries accumulate within the same surviving trace, but retry
backoff may appear only in total time. Collection does not change LLM prompts or
prompt caching. Footer output never enters stored model task history.

After delivery, save the timing snapshot and individual tool activity in the
existing record store, linking each delivered response to its request. Storage
failure does not change the delivery outcome. Successful original measurements
survive delivery recovery. No message text or tool arguments are copied into
these diagnostic records.

`timing_inspect` reads a request/response ID, defaulting to the reply target.
Members can inspect the current permitted channel only. Authorization is checked
again before cached tool-result replay. It explains recorded stages, first model
output and each tool duration; missing historical data is reported explicitly.
It cannot determine provider load or database/network root causes from elapsed
time alone. Progress updates and footers name each tool with an emoji and a plain name.

Streaming event writes use batches of up to 32 events or 64 KiB, with a 250ms
periodic flush and an awaited flush at normal/error termination. Original event
payloads and sequence numbers remain intact. Abrupt process termination can lose
the small not-yet-flushed buffer; batching does not make uncommitted events durable.
Journal time is measured inside its model/tool stage, not added again. Streaming
after the first output still includes generation and must not be described as
pure I/O or journaling.

Participation records a nested channel queue wait and actual classifier duration
separately. The outer participation total includes both. Some providers return
reasoning before text; a short visible classifier answer can still take time.
