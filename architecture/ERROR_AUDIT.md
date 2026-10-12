# Error audit — 2026-10-12

`agent round` is an outer error boundary. It does not mean all errors originate in one module.

| Failure | Root cause | Fix and regression |
| --- | --- | --- |
| Tool context invalidated, job f146a68a-472f-4103-a5eb-6825b7c3fbc6 | PostgresStore.agentTurns rejects saved invalid plans. History imports own Working status; its next edit invalidates the channel. This interaction predates the budget changes; longer reports exposed the 60-second importer interval. | Transient status normalization and SQLite/Postgres lifecycle handling. context-lifecycle and discord-source-boundary tests. |
| Context budget boundary | Old history filled input before tool working space was reserved; active results accumulated without checkpoints. | Existing reserve/checkpoint fix 96eab29; historical probes reproduce both failures at 7f48d46. |
| 1,200-token report limit | decision_lookup and conversation_summary hardcoded 1,200; file_read hardcoded 1,024 independently of reply configuration. | Shared model allowance in 7860f7c. Historical probes reproduce all three caps. Nimbus remains 50,000 output / 200,000 total; Cirrus 32,000 / 64,000. |
| Eight-tool restriction | Round limit, native parser batch limit and envelope batch limit were independent. | Default 64 rounds, shared 64 calls per batch. Historical round probe and provider boundary tests. |
| Tool protocol failures | Missing native schemas/streamed IDs and result pairing; generic errors obscured malformed/truncated provider streams. | Prior native protocol fix 7f48d46 plus explicit provider boundary codes and journal preservation. |
| Image context rejection | Encoded image transport counted as literal UTF-8 text. | Fixed per-frame engineering reserve; provider-boundary regression. |
| Missed/false source changes | Duplicate imports never refreshed newer edits; old snapshots could roll back canonical sources; preview/signature metadata looked authored. File guard incorrectly required caption AND attachment change. | Shared semantic fingerprint, revision timestamps, derived-preview marker, independent source checks. |
| Deleted requester retained valid plan | Invalidation found plans through already-deleted canonical message rows. | Durable run scope plus exact source ID invalidation. Lifecycle regression. |
| Stale or oversized Working display | Cleanup required a populated activity footer; eight 500-character failure reasons exceeded Discord limits. | Always clean up after final delivery; allocate bounded reason space. |
| First changelog deployment failed | PMServers unset-env rejects absent variables. | Only clear existing overrides (7860f7c); deployment regressions reproduce absent and partially present environment failures at f2720af. |

Large bot_info topic enums also reproduced a slash registration failure: Discord accepts at most 25 choices. The builder now leaves larger enums as typed inputs while retaining ToolRegistry validation (server-tools regression).

## Evidence and limits

Production logs for f146a68a confirm PostgresStore.agentTurns → appendTurn after a completed tool. Discord showed decision_lookup taking 94.5 seconds and bot_info left running. The own-status import/edit path is reproduced deterministically. The exact source mutation for that historical job is inferred: direct database inspection was unavailable because the tunnel host could not resolve. Future context_invalidated records identify it explicitly.

The initial generic 39-second job b2b7eafc-58f7-4fd7-97e3-7c0e935485b3 cannot be diagnosed from timing output alone. No claim is made that every historical generic failure had the same cause. No production job was blindly retried, and invalidated saved plans are not resurrected.

## Reproduction

Run `npm test` for current behavior, including historical-compatible probes. PostgreSQL tests require TEST_DATABASE_URL and run in CI against its isolated test service, not production.

For historical behavior, build an archived checkout with dependencies installed, then run the current probe file with SLOPBOT_AUDIT_ROOT pointing to that checkout:

```sh
SLOPBOT_AUDIT_ROOT=/path/to/built-baseline node --test scripts/development/error-regressions.test.mjs
```

Use 7f48d46^ for missing schemas/IDs and eight rounds; 7f48d46 for report caps, tool reserve and active checkpoint failures. Baseline-compatible probes use APIs already present in those revisions. Run scripts/deployment/ci-deploy.test.mjs against f2720af's deploy script for absent-variable failures.

Captured baseline results: 3 native/round failures, 3 inspection cap failures, 2 context failures; 9 initial lifecycle failures, 3 Discord source boundary failures, 2 deletion/ownership failures, 12 provider boundary failures, 3 snapshot/preview failures and 2 progress failures. Each was observed before its corresponding fix. Current isolated release: 274 passing checks and six local PostgreSQL skips; CI supplies PostgreSQL coverage.

Completed tool results, raw provider streams and operation journals remain available. Real source changes stop remaining actions and require a fresh request; no partial provider tool batch is executed after a failed generation.
