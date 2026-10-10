# Implementation boundaries

`Application` validates and ingests requests, checks allowed scopes, and serializes work within a task. It delegates execution to `AgentRunner`.

| Module | Owns |
| --- | --- |
| `src/context-builder.ts` | Source-linked context, profiles, recall, reference priority and input budgets |
| `src/request-routing.ts` | Deterministic reply-subject, quote, clarification and tool-selection rules |
| `src/agent-runner.ts` | Stable prompt prefix, model/tool loop, durable events, checkpoints and context-version checks |
| `src/reply-renderer.ts` | User-facing identity formatting through a profile lookup |
| `src/tools.ts` | Shared tool registration, arguments, permissions and operation journal |
| `src/adapters/discord.ts` | Discord normalization, channel permissions and delivery |

Keep new feature rules out of `Application`. Add external actions through `ToolRegistry`; add file decoders through `FileReaders`. Change context selection in `ContextBuilder`, request shortcuts in request routing, and presentation in `ReplyRenderer`. These are explicit modules, not a general plugin framework.

Internal user IDs remain in source records, prompts and logs. The renderer resolves known IDs to names in ordinary prose. Code, quotes, mentions and URLs remain intact. Unknown numeric identifiers are retained rather than guessed. The same renderer runs at Discord message delivery, including recovered jobs and direct tool messages. SQLite no longer formats replies.

The refactor preserves prompt text and prefix versions, source manifests, reasoning events, checkpoint behavior and action recovery. Existing English request shortcuts are isolated in request routing; they are still heuristics.

# Next work, in order

1. Repair file handling against real Discord events. Cover uploaded files, external GIF embeds, embed updates, mention-only messages and replies to old attachments. Confirm frame extraction and the actual provider response together. The reported GIF failure remains unresolved.
2. Completed: structured tool results carry display text, message/web sources, artifact links and explicit task handoffs. The runner consumes metadata, and source tracking no longer uses inspection-specific SQL. Existing plain-text results remain readable.
3. Make request routing use explicit rule results with priorities and ambiguity handling. Keep tool-specific matching in tool definitions. Add real conversation regression cases for corrections, person lookup and shared task follow-ups.
4. Split SQLite responsibilities into message, identity/profile, retrieval, task and run repositories behind the existing service interfaces. Keep migrations and transactions in the database adapter.
5. Add operational diagnostics for failed jobs, model capabilities, token/cache usage and embedding backlog. Resolve or replace the remaining vulnerable document dependencies.

Do these before adding more tools or changing databases.

# PostgreSQL / pgvector migration

The core context/model code already uses Store, Recall, LLM and ProfileStore interfaces. A PostgreSQL adapter can implement those contracts; pgvector retrieval belongs behind Recall.

`DATABASE_URL` now selects the PostgreSQL/pgvector adapter; without it startup uses SQLite. Discord consumes RuntimeStore. Queue, tool journal, delivery and task writes are awaited. Postgres serializes repository operations on one connection to preserve transaction boundaries. Settings and task listings are cached at startup and updated after durable writes. This deployment runs one bot worker.

Migration imports canonical messages, native vectors, source relationships, profiles, jobs, deliveries, task histories, original model events and harness transitions. The encrypted snapshot is imported in one transaction, row counts are verified, and a fingerprint makes replay idempotent. Worker leases are reacquired on the new host.

