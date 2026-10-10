# Shared sessions and memory proposal

Status: proposed. This document supplements UX.md; it does not change accepted requirements or implement the design.

Slopbot should own durable conversations that multiple people can contribute to. A session belongs to a conversation, with participants recorded individually. Each model run receives a bounded context assembled from stored records. It is not the session itself.

## Boundaries

| Record | Purpose | Lifetime |
| --- | --- | --- |
| Channel history | What people actually said, with authors, timestamps, reply links and revisions | Subject to retention and channel access policy |
| Conversation | Related discussion, its messages and participants | Can become dormant and resume later |
| Task | A conversation with a goal, decisions, constraints, pending actions and artifacts | Until completed or abandoned; remains available for later continuation |
| Run | One model/tool execution over a fixed input snapshot | Ends on completion, failure or cancellation |
| Memory | Attributed facts or decisions worth retrieving later | Until corrected, expired or deleted |

A casual exchange gets a lightweight conversation record. It needs no task plan or permanent model session. Promote it to a task when the request involves sustained work or tool activity. Put agentic output and subsequent work in a Discord thread, as UX.md requires. The original channel message and all bot reply chunks map to that task, so replying to the original message still finds it.

Use one primary task per bot-created Discord task thread. Multiple tasks in the same channel may run independently. A new request in the channel does not inherit whichever task ran most recently, and a user's unrelated requests do not share a mutable history merely because the author is the same.

## Routing messages

Apply permissions and channel exclusions before routing or retrieval. Then resolve messages in this order:

1. An explicit command to start, resume or branch a task selects the destination.
2. A Discord reply to a mapped message selects that message's conversation. Preserve the referenced message as the local focus.
3. An unreferenced message in a bot-created task thread belongs to that thread's task by default. An explicit reply to another conversation takes precedence, subject to access checks.
4. In an ordinary channel, use recent reply links and bounded nearby context to recognize a clear continuation. If uncertain, create a lightweight conversation with relevant nearby messages as background. Ask only when choosing the wrong task would change work or cause an action.

Conversation membership and response eligibility are separate decisions. Store an eligible channel message even if JEV chooses silence. A joke may be part of a conversation without changing its goal or producing a bot answer.

Recommended clarification to UX.md: when JEV is off, explicit mentions, replies to Slopbot, slash commands, and contributions in an active bot-created task thread can trigger a response. Name-only requests in ordinary channels still require JEV. This is a proposed expansion of the current "only explicit pings" rule. Channel exclusions always win. Explicit requests bypass unsolicited-response cooldowns, but still obey queueing and resource limits.

Replying to an old message resumes the current conversation state while focusing on that old message. It does not roll the task back. If someone wants to explore an old alternative independently, provide an explicit branch action that copies the relevant state and records its source version.

## When two people reply at once

Default to one shared conversation and one ordered queue. Do not fork merely because the reply graph has two children.

Example:

```text
Slopbot: Which weekend and what budget should I use?
Alex replies: Saturday works.
Sam replies: Keep it under $200 per person.

Slopbot: I'll use Saturday and a $200-per-person budget.
```

Persist both messages immediately with their own authors and reply targets. Assign an ingress sequence within the conversation. Before starting a run, allow a short batching window, initially about 750 ms with a two-second maximum wait from the first message. Those are tuning defaults, not correctness requirements. Consume the pending prefix as one turn while preserving each message separately in the prompt. Do not concatenate people into one anonymous user.

If Alex says Saturday and Sam says Sunday, preserve both proposals. Slopbot should ask which to use, or use a previously agreed decision rule. Arrival order and confidence are not evidence of group consensus. An ordinary participant can add a suggestion; the bot must not represent that as everyone agreeing. Consequential actions need an authorized requester and resolved required inputs.

If Sam's message arrives after Alex's run starts:

- Queue it for the next run. A run's input snapshot is immutable.
- If it changes the premise of an unsent answer, discard or revise the draft using the new input before publishing. Keep a bounded retry policy so constant conversation cannot prevent all responses.
- If the answer is still useful, publish it and process Sam's message next. Record which input sequence the answer covered.
- Before an external write, check for pending corrections or cancellation at a safe boundary. Relevant changes require revalidation before proceeding.
- If the write has already been sent, record the actual result and explain any correction needed. Cancellation cannot undo an external action.

For long runs, show one brief acknowledgement of queued contributions in the task thread when useful. Avoid one progress message per arrival. Give stop/cancel commands priority at safe execution boundaries. Ordinary chatter should not repeatedly restart a running job.

Batch only inputs compatible with the same execution and authorization context. Two people's read-only planning contributions can share a run. Requests using different personal credentials must remain separately authorized operations with their own requester IDs.

## Execution and recovery

Use a durable per-conversation queue and at most one active writer for each conversation. Different conversations can run in parallel, under server and global limits. A global lock would make unrelated work wait.

For the first deployment, one worker and a transactional database are sufficient. Store queue state in the database rather than relying on an in-memory mutex. If multiple workers are added, use expiring leases with fencing tokens so a worker that lost ownership cannot commit stale state. Commit state changes against the expected conversation version.

A run records its input boundary, source revisions, state version, context manifest, requester identities, status and tool operations. Ingesting messages continues while a run executes. Under the conversation's serialized coordinator, commit the covered input boundary, updated task state and pending outbound response together. New arrivals remain pending. Do not hold a database transaction open across model or network calls.

Deduplicate Discord deliveries by server and message ID, with revision handling for edits. Use an outbox to recover pending Discord sends. Track individual output chunks and their conversation mapping. An outbox alone cannot guarantee exactly-once delivery after an ambiguous network failure; reconcile where possible instead of blindly reposting.

Give tool operations stable operation IDs and persist started/succeeded/failed/unknown status. Reuse provider idempotency support where available. After a crash with an unknown external result, inspect that result or request resolution before retrying a destructive operation. Never replay every tool call just because a run did not finish.

## Topic drift and returning to work

Keep the task goal and current state separate from its transcript. Side conversation may be stored and understood without becoming a task constraint or displacing the goal.

In a task thread, answer a short aside when addressed, then preserve the existing task. A side request that becomes substantial should get a separate conversation or task with a parent link. Make the split visible, and copy only the context it needs. Do not silently split a task based on one classifier prediction.

In an ordinary channel, recent chat provides social context but does not automatically continue a task. Reply links and explicit references are stronger routing evidence than semantic similarity. "Back to the trip" can retrieve an existing task; ask which one if several match.

Inactivity makes a task dormant and releases runtime resources. It does not erase the task or imply success. Completion is a recorded state with an outcome. A later reply can reopen it if more work is requested. Revalidate time-sensitive facts and permissions when resuming old tasks.

## Memory and context

Use a transactional database as the source of truth. The required vector index is a rebuildable search projection. It should help find records, not determine task ownership or authorize access.

Store four kinds of information separately:

| Kind | Contents | How it enters a run |
| --- | --- | --- |
| Source messages | Exact available text, author ID, reply target, attachment/GIF interpretation, edit version and deletion status | Current inputs, selected reply ancestry, recent relevant messages and search results |
| Task state | Goal, constraints, proposals, accepted decisions, disagreements, open questions, next steps, artifacts and action results | Load compact current state for the selected task |
| Structured profiles | User fields, server-specific fields, edit permissions, editor identity and undo history | Fetch relevant allowed fields after resolving a stable user ID |
| Recall records | Summaries, reusable server facts and prior task outcomes, with source references and scope | Retrieve only when relevant to the current request |

Task decisions should record who proposed or accepted them and link to supporting messages. Keep unresolved alternatives explicit. A summary must not turn "Sam suggested $200" into "the group agreed to $200." Record corrections as superseding earlier decisions rather than silently overwriting their history.

Conversation-driven profile changes must use the same validated mutation path as slash commands. Preserve ownership locks and editor audit records. Do not silently promote jokes, guesses or third-party claims into authoritative personal facts. Nickname search can find candidates; stable Discord IDs identify people. Ambiguous names need disambiguation.

Make memory scope explicit: conversation, channel, server, or user. Personal data also needs a visibility policy. Globally stored user information should not automatically be disclosed to every server the user joins. The public profile-dump requirement needs a defined public projection so a dump does not expose private or other-server fields. Explicitly shared global fields can appear alongside the current server's fields.

Assemble each run's context in this order:

1. Bot policy, current permissions and available tool definitions.
2. Current task state, when applicable.
3. New messages with separate authors, timestamps and reply targets.
4. The referenced message and relevant ancestors, plus a bounded local conversation window.
5. Retrieved older evidence and relevant profile fields.
6. Relevant tool results and artifact references.

Reserve space for the answer and tool loop before filling the input budget. Respect the independently configurable preceding-message limits for JEV and the reply model, and also enforce token and attachment limits. Drop irrelevant retrieval first when the budget is tight. Keep current instructions, disputed decisions and action results intact; fetch long artifacts in pieces when needed.

Summarize older conversation segments with source message IDs, covered sequence ranges and source versions. Retain a recent verbatim window alongside the summary. Store structured task state independently so repeated summary compression cannot gradually erase constraints. Expose a compact task-status command for people to inspect and correct it.

Keep retrieved messages and tool content clearly identified as evidence, with their authors and scopes. They cannot replace bot policy or grant tool permissions. Record the context manifest for debugging why a reply happened, as UX.md requests, without exposing unrelated private material in diagnostics.

## Edits, deletions and excluded channels

An edit updates the canonical message revision and its search projection. Mark dependent summaries and derived facts stale, then regenerate or retract them. If the changed message affected an active run, revalidate before publishing or acting. Preserve completed action history truthfully; editing a request does not reverse what already happened.

A deletion immediately prevents retrieval of the source text and invalidates dependent derivatives, including embeddings, summaries, copied excerpts and GIF interpretations. Retain only minimal tombstone and operational metadata needed for deduplication or action accounting under a documented retention policy. A later message that independently supports a fact can remain a valid source.

Recommended exclusion behavior: stop ingestion and retrieval immediately, then purge previously stored channel content and its derivatives asynchronously. Apply this to child task threads as well. Cancel affected pending work and prevent active runs from publishing excluded content. Recheck access immediately before publication. Re-enabling a channel should not silently backfill it; use the explicit history-indexing command.

Apply server, channel and current visibility filters before vector retrieval and again when loading canonical records. Shared output may use only information allowed in its destination. A public task must not inherit private DM context from one participant. Policy changes should invalidate cached contexts, not just future searches.

## Small initial implementation

Start with logical records for messages and revisions, conversations and message mappings, task state and its version, queued inputs, runs and tool operations, an output outbox, profile fields and audit history, and source-linked recall records. These can live in one database. The vector database contains search projections keyed back to source records.

Build explicit reply routing, durable queueing, one writer per conversation and structured task state first. Then add bounded context assembly and scoped search. Add automatic topic suggestions after the deterministic paths work. Do not start with an autonomous agent for every person or an automatic branch for every reply.

Before implementation is considered reliable, exercise these scenarios:

- Two users reply to the same bot message before execution and both reach the prompt with correct attribution.
- A correction arrives during a run and is accounted for before any still-pending external write.
- Conflicting replies remain unresolved instead of becoming last-writer-wins decisions.
- Casual conversation does not overwrite a shared task's goal.
- An old reply resumes current task state and retains its referenced focus.
- Duplicate events, worker restarts and expired leases do not create competing state commits or blind action retries.
- Deleted, edited or newly excluded content cannot reappear through a summary, vector hit or cached prompt.
- Two unrelated conversations progress independently, and restricted information never enters a broader destination.

## Basis and open decisions

This proposal follows the local [UX requirements](UX.md). The original [Housebot README](https://github.com/bushshrub/housebot) describes per-user conversation history and persistent memory. The proposed shared conversation ownership addresses the group workflow. Source-file retrieval failed during this review, so this is not an audit of Housebot's implementation or its existing race behavior.

Before implementation, agree on the monitoring-off trigger expansion, who can approve consequential shared actions or override task decisions, the visibility of global profile fields, and retention periods. These are product policies; model inference should not decide them implicitly.
