# Prompt caching

The system instructions and sorted native function schemas form a stable prefix.
Schemas travel in the API tools field rather than the system message. Dynamic
profiles, retrieved messages and current requests follow that prefix.

Task conversations replay saved prompt snapshots and append new turns. Tool
rounds append assistant calls and tool evidence without rewriting earlier items.
Large tool results are shortened before insertion; full results and reasoning
events remain in the action log. If no new evidence fits, the request stops
instead of silently removing earlier context.

Fresh channel requests share the fixed prefix; their selected context can differ.
Task checkpoints at context limits deliberately start a new cache prefix. Source
edits, deletions, changed instructions and changed tool catalogs can also
invalidate cached context. Correctness takes priority over cache reuse.

The AI gateway performs automatic caching and has reported nonzero
`cached_tokens` in recorded requests. No client can guarantee a hit on every
request: provider routing, cache eviction and minimum prefix lengths also apply.
Client `client_prompt_cache` events record hashed prefix stability and whether a
request is an append, repeat or branch. Provider usage reports actual cache hits;
these are separate measurements. Client scope identifiers are not sent as
provider-specific cache controls.

Native assistant/tool message pairs retain their call IDs across retries. Schema bytes are included in input budgeting. Cache diagnostics report tool count and schema fingerprint; a schema change is a new branch even if message text is unchanged.
