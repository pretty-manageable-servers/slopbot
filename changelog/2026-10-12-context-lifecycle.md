# Tool execution and context reliability

- Fixed live tool status edits interrupting active requests after history imported the status message.
- Source changes now identify their reason and source ID instead of appearing as UNEXPECTED_ERROR. Completed results remain saved and visibly completed; stale remaining actions stop.
- History imports pick up missed edits and reject older snapshots. Attachment signature refreshes and automatic previews no longer invalidate unchanged instructions; actual captions and file changes remain checked.
- Native and envelope batches support 64 calls, matching the larger round allowance. Provider network, interrupted/malformed streams, filtering and empty responses have distinct errors.
- Image context estimates exclude base64 transport bytes. Calls without an explicit output override send the configured model allowance.
- Long failure statuses fit Discord's message limit, and final error replies remove the Working display.
- Added failing-before-fix regressions for these bugs and historical tool schema, output cap, context packing and deployment cleanup failures. Updated bot_info.
- Fixed slash-command registration when bot_info topics exceed Discord’s 25-choice limit. All topics remain valid typed inputs.
