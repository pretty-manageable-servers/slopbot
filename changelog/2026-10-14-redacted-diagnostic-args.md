# Retain bounded diagnostic tool arguments

New agent turns save a separate redacted argument snapshot for each call, capped at 2 KiB of UTF-8 JSON. `interaction_inspect` returns these snapshots, including program code. Credentials and sensitive keys are redacted before truncation. Large arguments are explicitly marked as excerpts.

Existing turns retain null diagnostic arguments. Their original execution arguments are not backfilled into diagnostics. Public issue evidence still contains source links rather than diagnostic snapshots.
