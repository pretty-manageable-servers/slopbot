### Internal tool output limits fixed
- Decision lookup, conversation summaries, and file inspection now use the configured model output allowance instead of separate 1,200- or 1,024-token caps.
- Output-limit errors identify the actual request budget and configured allowance. They no longer recommend a setting that cannot affect the failing call.
- Reports and file inspections use readable evidence text and retain their original sources and partial model output.

### Deployment retries
- Deployment now removes token overrides only when they exist, so repeating a deployment no longer fails on already-cleared settings.
