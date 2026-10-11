# Presentation policies

Discord selects `discordPresentation` from `src/presentation/discord.ts`. Each ordered rule has an ID, optional model instruction, and a text transformation. Add or change a rule there to adjust Discord formatting. Other gateways can select another policy without changing application behavior or stored model output.

The policy's instructions are appended to the stable system prefix. The normal prefix hash changes only when its content changes, preserving prompt caching between requests. ReplyRenderer applies the policy before resolving user IDs; Discord splits the resulting text into messages afterward.

The table rule asks for paragraphs or lists and converts unexpected Markdown tables into labelled list rows. Fenced code remains untouched. Explicit verbatim rendering bypasses transformations. Raw responses and reasoning remain in storage.

`suppressLinkPreviews` in the Discord presentation module disables link embeds when a complete reply contains more than one HTTP(S) link outside code. The adapter applies this to every message chunk, including slash-command output. Links remain clickable; single-link replies retain previews.

Tool execution emits `ToolActivity` events through an optional application observer. Discord updates one temporary status message per request, then appends a grouped tool summary to the final reply and removes the status message after delivery. Rejected calls and reused results are labelled explicitly. Arguments and raw results are not displayed. Status display failures do not stop execution.

Change tool labels, progress layout, or footer layout in `src/presentation/tool-activity.ts`. Discord message lifecycle belongs to `src/adapters/discord-tool-progress.ts`; other transports can use the same events with their own display. Stored replies remain unchanged, and durable reply metadata retains the tool summary for delivery retries.
