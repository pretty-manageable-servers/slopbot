# Edit your Slopbot issue reports

The original reporter can ask Slopbot to replace an issue body or remove its collected-evidence section through `issue_report_edit`. The tool verifies the issue URL and creation marker against the durable operation journal, including reports created before this feature. Public footer text alone cannot establish ownership.

Edits require access to the original reporting channel, redact credentials and stay within 8 KiB. They preserve creation provenance and reconcile a lost GitHub response before retrying. No duplicate issue or comment is created.
