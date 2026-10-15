# Add owner-only global profiles

The profile tool and slash command accept `scope:global` for an account profile shared across servers. The default remains `scope:server`. Global fields are readable across servers; only the account owner may add, remove or undo them. Server admins cannot override ownership, and edit access cannot be opened to others.

Global fields are explicitly published account facts. They contain no server identity or source-channel metadata and persist until their owner changes or removes them, including after the original message is deleted. The latest 200 edits support owner-only history and undo. Global owner facts override conflicting server fields in model context. Concurrent edits use revision checks to avoid lost updates.
