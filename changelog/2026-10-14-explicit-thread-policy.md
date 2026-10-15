# Centralize automatic task-thread routing

`src/thread-policy.ts` is the single policy table for native write tools. Channel management, indexing, issue reporting and editing, fix watches and task retries request a thread. Sandbox management requests one only for template builds. Other native tools stay inline, including memory, profile and configuration edits. `task_start` creates its explicitly requested thread itself.

Mixed-action reads never request a thread. External and custom writes retain a safe thread default unless explicitly configured inline. A test scans native registrations, names tools missing a policy and checks registry routing against the table.
