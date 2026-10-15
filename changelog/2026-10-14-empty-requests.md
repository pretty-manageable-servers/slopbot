# Skip empty requests and render readable errors

Empty or whitespace-only messages do not start classification or agent work. Attachment-only messages still work. Queued requests that were edited to an empty body are skipped before invoking the model.

Failure notices render in a plain-text block, with readable error codes and field names. Backticks in error text cannot close the block. Request and job identifiers remain visible.
