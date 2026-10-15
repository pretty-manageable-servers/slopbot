# Retry transient participation failures

Participation classification retries transient HTTP failures and network timeouts up to three times with bounded backoff. Exhausted attempts produce an operator log signal and a saved classifier health record. The decision history retains the failure and retry outcome for `why`.

Recent unanswered messages receive up to two additional checks ten seconds apart, within a one-minute freshness window. Recovery skips changed or deleted messages and rechecks channel participation and mute settings before answering. Authentication and validation failures are not retried.
