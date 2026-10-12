# Auger state machine

Slopbot ports the session diagram from [Auger at commit 7e126e0](https://github.com/bushshrub/auger/blob/7e126e04d3cf7f223bd31824a9b95b1531cade64/auger-core/auger-statemachine.mmd). The diagram is retained in [auger-state.mmd](auger-state.mmd), and the corresponding TypeScript reducer is `src/harness-state.ts`.

The model lifecycle is explicit: waiting, streaming, interrupting, interrupted, failed, tool phase and held results. Each tool call is undecided, running, done with a withheld result, or done with automatic continuation. The machine rejects invalid transitions. Execution failures count as completed results and return to the model for recovery. A batch continues only after every call finishes; any withheld result or an entirely denied batch holds continuation until another message.

`AgentRunner` drives this machine while retaining the existing model adapter, context builder and central tool registry. SQLite appends transitions to `harness_events`; agent turns and the operation journal retain tool calls and actual results. Recovery reconstructs pending tool phases from those durable turns and consults the operation journal before execution. An uncertain write cannot be replayed as a new attempt just because a process restarted.

Slopbot adaptations:

- Existing permission checks make the execution decisions. There is no new approval prompt or safety classifier. Permission/validation errors display as blocked, while known execution failures display as failed. The actual reason appears in the reply and tool activity. If every call is blocked or failed, the runner leaves results held without making further model or tool calls. Saved error results retain their reasons.
- Tool execution remains sequential. The existing durable queue preserves contributions from different people; it does not overwrite messages with Auger's single queued-message slot.
- `Application.interrupt(server, messageId)` cancels the active request's provider stream and prevents subsequent tool calls. Already-started actions settle and keep their actual results in the journal; they are never reported as rolled back. No Discord cancel command is wired yet.
- Partial text from a failed or interrupted stream can enter retry context as labeled evidence when the source/context version is still current. Original reasoning and opaque events remain untouched; raw reasoning is not replayed as ordinary chat.
- Slopbot adds a `ToolRejected` transition for execution-time rejections. The pure reducer also supports withheld decisions, but no user approval UI currently produces those decisions.
- Lifecycle state is recorded per durable request. Shared task history/checkpoints remain managed by the existing task layer.

The upstream Rust state enum uses additional implementation phases around tool consent and execution; this port follows the published session diagram's lifecycle, rather than copying Auger's provider/server/runtime.

The adapted module and copied diagram are attributed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). The upstream AGPL license is retained under `licenses/`.

## Error diagnostics and round budgets

`src/errors.ts` provides bounded, redacted error codes, messages, recovery suggestions, cause chains and structured logs. Replies, jobs and failed runs retain the actual reason. Known tool failures and blocked calls remain distinct from uncertain effects. Background fallbacks log their original exceptions. Errors are correlated with available job/run/message/tool/operation IDs.

`MAX_TOOL_ROUNDS` defaults to 64 and accepts 1-1000. It limits new model/tool rounds in one attempt, not the number of individual calls or all historical progress. A retry reconstructs saved calls/results and gets a fresh allowance. Reaching the limit raises `TOOL_ROUND_LIMIT` with the limit, completed round count and requested next tool names. Context budgets and per-tool limits still apply.

Native calls retain provider IDs in the existing durable JSON call records; results reconstruct `role:tool` messages with matching `tool_call_id`. Stable operation IDs remain separate and prevent duplicate execution on recovery. Legacy saved calls receive deterministic conversation IDs during native replay. No database schema migration is required.

Task history reserves space for tool calls/results before packing. Active loops checkpoint older completed work before the input budget fills, preserving the current request, latest complete native tool batch and all original journal records. Recovery rebuilds checkpoints and reuses saved tool results. A genuinely oversized call reports CONTEXT_BUDGET with estimated input-unit figures instead of UNEXPECTED_ERROR.
