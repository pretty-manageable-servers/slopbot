# Recover from unsupported Unicode in stored content

PostgreSQL parameters now replace null characters and unpaired Unicode surrogates with the Unicode replacement character before storage. Valid emoji and literal backslash escapes remain intact, including inside JSON tool results.

Database failures identify the SQL operation and table in structured logs and notices. Job failure notices include the request ID alongside the job ID.
