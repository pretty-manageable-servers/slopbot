# Add a tool once

Register a `ToolDefinition` in `ToolRegistry` at startup. Both native API function schemas and `/slopbot` commands use that definition. The generic `/slopbot run tool:<name> arguments:<JSON>` supports tools beyond Discord's subcommand limit.

```ts
registry.register({
  name: "ticket_create",
  description: "Create a ticket requested by the user",
  fields: { title: { type: "string", description: "Ticket title", required: true } },
  access: "member",
  effect: "write",
  retrySafe: false,
  resource: message => `tickets:${message.server}`,
  async execute(context, args) {
    await context.assertActive();
    return tickets.create(String(args.title), context.operationId);
  },
  async reconcile(context) {
    return tickets.findByOperationId(context.operationId);
  },
});
```

`tickets` above is an injected service adapter, not a built-in integration. Supply its URL and credentials at startup. Its methods return a result string, or `undefined` from reconciliation when the outcome cannot be established.

- Fields are validated centrally. Structured `json` fields can declare a schema for the model; enforce that schema in the definition's `validate` callback.
- `access` uses the requesting user's current Discord permissions. Connectors must also enforce access to their own resources. Never accept an admin flag from tool arguments.
- `effect` separates reads from writes. Mixed-action tools supply `writes(args)`. Native automatic thread routing is declared in `src/thread-policy.ts`: channels, index, fix_watch and task_retry request a thread for writes; sandbox_manage does so only for build_template. Other native tools stay inline. task_start creates an explicitly requested thread itself. Mixed-action reads never request a thread. External/custom writes default to a thread unless configured inline. Arguments and results are posted there, so never expose credentials through either.
- `resource` identifies the shared object being changed. Writes serialize on that key; an unresolved operation blocks later writes to that key for 10 minutes (`UNCERTAIN_LOCK_MS`) unless the tool sets `staleAfterMs`. Other keys are not blocked. Call `assertActive()` again after asynchronous preparation and immediately before the external action.
- Use the stable `operationId` as the external service's idempotency key. Set `retrySafe` only when repeating the operation is safe. Otherwise implement `reconcile`; an unknown result pauses the job. Throw `ToolError` only for a known rejection with no uncertain side effect.

Keep service clients outside the core. Native tools register at startup. Runtime providers replace their own definitions atomically through `replaceProvider()`. Each agent request captures a catalog; changing it changes the prefix version for subsequent requests. An active request keeps its captured catalog, and attempts to invoke changed or revoked definitions are rejected. Existing LLM, embeddings, storage and chat transport interfaces remain independent of tool connectors.

Tools may supply `matchRead(message)` for a narrow, unambiguous read intent. The registry validates it and the same permission-checked executor runs it. For example, an indexing-status request selects `index` directly and returns its actual result. Matches never authorize writes. Legacy text-protocol failures have at most two repair attempts; native calls retain provider IDs and validate their arguments before execution. Each failed run retains its original events.

Request uploads. When the bot answers a request (mention, reply, private chat, task thread or name request), each non-image attachment is copied to `<home>/uploads/<name>` in the task sandbox, where `<home>` is the sandbox home from the startup profile before the model run. Images stay inline for vision. The limit is 10 MiB per file, using the Discord fetch rules. Two files with one name get `-1`, `-2` before the extension. A failed upload is logged and reported in the request context as `upload_failed`; the run continues. The request context lists the copied paths as `uploaded_files`. Messages that are not requests do not upload. Source: `src/sandbox-uploads.ts`.

## Self-improvement tools

`registerOperationsTools` registers member reporting capabilities in dynamically discovered servers when GitHub credentials are configured. Admin diagnostics and fix watches additionally require `SLOPBOT_OPERATIONS_GUILD_IDS`. `interaction_inspect` is a member read with current source-channel checks; github_issue_read, issue_draft and file_report also allow members; repository/infrastructure diagnostics and fix watches require Manage Server. Members can publish only interaction evidence from channels they can currently access. `pipeline_read`, `deployment_inspect`, `ci_inspect`, `service_inspect` and `github_issue_read` read a fixed repository or allowlisted PMServers containers. Read tools expose structured data for `run_tools_code`. There is no generic HTTP, host shell, code-write, merge, restart or deployment action. Existing runtime MCP grants remain the extension mechanism for future capabilities.

Each diagnostic capture is an immutable `diagnostic_evidence` app record, keyed by the operation and task channel. It retains capture time, safe structured data, source fingerprints and permission-dependent log channels. Replay and publication recheck channel visibility and source changes. Captures are bounded to 48 KB, with explicit truncation; source text is opt-in. Run start saves `run_runtime` build SHA/time and execution time for both database adapters. The production image embeds build metadata. Historical runs with no metadata explicitly report an unknown version. Prompt inventories retain roles/counts, never prompt text or provider reasoning.

`issue_draft` saves one draft per channel or thread: title, expected and actual behavior, steps, an acceptance check, optional hypotheses and missing evidence, and up to 8 cites (message refs, message IDs or tool-run IDs). Each cite is snapshotted when the draft is saved. Validation errors return to the model. `file_report` files the open draft as a GitHub issue, or as a comment on `issue_number`, when the requester or a bot admin runs `/file-report` or the card's File report button. GitHub writes use `retrySafe:false`, a stable hidden operation marker and a durable intent recording whether the action is issue creation or a comment. Recovery scans up to 1,000 recent issues/comments without relying on GitHub search indexing. If no marker is found, the result stays uncertain; absence never authorizes another POST. Only confirmed client-side rejection ends a write as failed; network and server failures remain uncertain.

`fix_watch` persists a watch with an issue, optional selected PR and acceptance check, with at most 20 active watches per server. `FixWatchWorker` polls every minute, persists pending notification intents before delivery, and reuses the Discord delivery journal across restarts. It rechecks owner admin/channel access before polling and delivery. PR candidates come from the first 100 issue timeline events; ambiguous links require explicit selection. Snapshots include CI and live infrastructure state without claiming the application behavior is fixed. Passed/failed verification requires a merged fixing PR included in the deployed SHA, and a recorded interaction on that SHA after deployment. Observations remain attributed to the requester; Slopbot does not independently run application tests or close issues.

Configure `SLOPBOT_OPERATIONS_GUILD_IDS`, `SLOPBOT_GITHUB_REPOSITORY`, `SLOPBOT_GITHUB_TOKEN`, `SLOPBOT_PMS_PROJECT_ID`, `SLOPBOT_PMS_TOKEN`, and `SLOPBOT_PMS_CONTAINERS`. GitHub requires Contents/Actions/Pull requests read and Issues write. For App authentication, set SLOPBOT_GITHUB_APP_ID, SLOPBOT_GITHUB_APP_INSTALLATION_ID and SLOPBOT_GITHUB_APP_PRIVATE_KEY instead of SLOPBOT_GITHUB_TOKEN. Slopbot signs App JWTs, caches repository-scoped installation tokens, refreshes them one minute before expiry, and refreshes once after a definite 401 rejection. Other write failures are never retried blindly. See [GitHub App setup](GITHUB_APP.md). PMServers uses `/v1/projects/{project-id}/containers`, per-container `/logs?tail=&previous=`, and project `/events`, filtered to configured container IDs. The adapter sends GET requests only, although the project token itself can have broader provider permissions. Neither CI credentials nor existing sandbox keys are implicitly reused.

Sources: [GitHub issue API](https://docs.github.com/en/rest/issues/issues), [GitHub job logs](https://docs.github.com/en/rest/actions/workflow-jobs), and [PMServers container client](https://github.com/pretty-manageable-servers/pmservers-cli/blob/main/crates/pms-client/src/containers.rs), reviewed 2026-10-13.

## Structured results

Tool implementations can return `{ text, status?, sources?, artifacts?, handoff? }`. Sources distinguish canonical messages from web URLs; artifacts carry a URL and label; a handoff carries a thread ID. Tool results are trusted connector output, not model-supplied arguments. Each connector must authorize its source access before returning metadata.

Tools can also return `data` containing structured JSON. The journal retains it in full. Large structured data is omitted from the bounded model trace with an explicit notice. A tool with `inputSchema` must provide a validating callback; `outputSchema` describes its structured result. Imported MCP definitions use this path rather than reducing nested schemas to Discord command fields.

## Runtime MCP connections

Admins manage connections in the web console's **MCP connections** tab. Adding a standard remote server does not require source edits, a GitHub push, restart, or redeployment. The initial installation of this feature requires the usual deployment. Connections and explicit tool policies persist through the existing `app_records` store in SQLite or PostgreSQL. Run one bot process per database.

`McpManager` owns discovery, live clients, publication, retirement, and restoration. `remoteMcpConnector` uses the official TypeScript MCP SDK with Streamable HTTP or explicit legacy SSE transport. URLs must have no credentials, query parameters, or fragments. Public endpoints require HTTPS. No sampling, filesystem roots, or elicitation capabilities are exposed.

Connection setup has two steps: connect and discover, then select tools and assign member/admin access and read/write behavior. All tools start disabled; remote annotations do not authorize access or determine retry safety. Member grants share the connection account's capabilities with guild members. Imported tools have stable names derived from connection ID and remote tool name. They appear in new model requests and `/slopbot run tool:<registeredName> arguments:<JSON>`. Dedicated Discord subcommands remain native-only, avoiding command registration on each runtime update.

Every call validates its full input schema, current membership and channel visibility, and the current connection grant. Admin access is rechecked immediately before dispatch after any concurrency wait. Writes use existing task-thread rules, resource locks, operation journaling, and uncertain-outcome handling. Writes are never automatically repeated merely because the remote server marks them idempotent. A remote error or invalid output after a write leaves an uncertain operation for inspection. Generic MCP does not provide application-specific reconciliation; use a native provider when automatic write recovery is required.

Refresh reconnects and discovers tools without enabling new ones. Input/output schema, description, or read-only annotation changes invalidate the existing grant until an admin reviews and enables it again. Failed updates keep the working connection. Disabled or removed connections reject new and waiting calls immediately; already-dispatched operations finish and their results are journaled before the old client closes. Disabling cannot undo an operation already sent to the server. Failed startup connections remain visible as unavailable and can be refreshed without restarting.

Bearer credentials are write-only console input. Set `MCP_SECRET_KEY` once to a base64-encoded random 32-byte key to enable credential storage. AES-256-GCM ciphertext is bound to the guild and connection ID. Keep the key stable and back it up with the database; rotating or losing it requires entering credentials again. Changing the endpoint clears the old token unless a replacement is supplied. Snapshots and configuration records never contain plaintext tokens. Updates record the actor and timestamp. Remote exception messages are not published or logged.

The network adapter validates the address used by each socket to block private/reserved destinations and DNS rebinding; it refuses redirects and cross-origin SSE message endpoints. `MCP_ALLOW_PRIVATE=true` is an operator-only override for trusted local/private servers and also allows plain HTTP. Defaults are 15-second RPC deadlines and four simultaneous calls per connection. Limits are 20 connections, 100 discovered tools per server, and configurable 1–60-second deadlines / 1–16 concurrent calls. Enabled schemas consume the normal context budget; deferred tool search is not implemented yet.

Runtime MCP configuration uses the existing model protocol. Slopbot's own programmatic runtime composes eligible reads as described below. OpenAI-hosted Responses API programmatic calling is a separate adapter/continuation change. OAuth onboarding and host process/stdio servers are not implemented; use anonymous or bearer-authenticated HTTP/SSE endpoints.

## run_tools_code

`run_tools_code` runs JavaScript that the model writes. The model passes one argument, `code`. Inside the code, `tools.NAME(arguments)` calls any tool of the core catalog or any tool that `list_tools()` returns. The core catalog is every registered tool with `surface: "catalog"`, sorted by name, in the tool description. It is the same for every user and channel. Access is checked on each call, not when the catalog is built. MCP tools have `surface: "discovery"`: they are reached only through `list_tools()` and `describe_tool(name)`. The native top-level tools (`read`, `write`, `edit`, `shell`, `web_search`, `web_fetch`, `task_start`, `ui_publish`, `voice_say`, `voice_skip`) are not in the catalog. Direct tools (`surface: "top"`) are native function tools too, and are not in the catalog: `history_search`, `history_read`, `memory`, `memory_remember`, `memory_update`, `memory_forget`, `bot_info`, `profile`, `file_store` (read actions only; its writes are `file_store_write`, in the catalog), `reminder`, `schedule`, `inbox_add`, `inbox_done`, `inbox_list`, `issue_draft`, `view_image`. A call to a direct tool from code fails with `NAME is a direct tool. Call it outside run_tools_code.` `run_tools_code` is registered last, so its catalog lists every tool registered before it.

Built-ins: `list_tools()` returns the tools this requester can use. `describe_tool(name)` returns the fields of one tool. `save_to_sandbox(path, data)` writes a string, or JSON for other data, to a file under the sandbox home directory. Relative paths and `~` start there.

Writes are allowed. Each child call goes through `ToolRegistry` with the requester's permission check and a stable operation ID made from the parent ID, the call index, the tool name and the arguments. A call whose tool has `confirm(args)` true stops the program. The pending call is saved in a `tool-confirm` record, and the bot posts Confirm and Cancel buttons. Only the requester can click. Confirm runs that one call once. Cancel ends the record. Pending records expire after 24 hours. The only call that needs Confirm is `channels` remove.

Limits: 60 seconds wall time, two seconds guest CPU, 32 MiB guest memory, 64 calls, four concurrent calls, 1 MB of incoming tool data, 16 KB of emitted output, and 16,000 characters of code. If a tool changes during a run, the current definition is used. A call fails only when its access is now denied. Failed calls stay visible even when the code catches them. Child calls carry `parentId` and appear in the progress line and the final activity list.

Code display: Discord shows one Tool runs button per reply in summary and full modes. It opens an ephemeral diff pager for the requester, with chronological tool names, redacted arguments and outcomes, statuses, and durations. Previous and Next update the same message using saved, expiring cursors. Large fields are explicitly truncated. Hidden mode omits the control. Legacy Show code buttons still work. Web chat shows the code in a closed Code block, with the child calls below it. Code and trace snapshots are kept for 14 days, then deleted or scrubbed by an hourly job.

The program runs in a worker running QuickJS compiled to WebAssembly. Generated code never runs through Node eval, Function, or node:vm. The guest has no host environment, filesystem, network, modules, subprocesses, timers, or persistent state. Its only host access is the JSON tool bridge and `text(...)`. Main-process callbacks resolve guest promises with bounded JSON. The parent enforces the wall-clock deadline and always terminates the worker.

`web_search` uses the WebSearch interface. The SearXNG adapter has a 15-second timeout, a 1 MiB response limit, up to 10 results and 30 requests per minute. It does not fetch result pages. Model output must treat snippets as evidence and cite their URLs.
# Bot self-knowledge

`bot_info` is a member-readable tool available to both slash commands and the LLM.
Its focused topics come from `BOT_GUIDE.md`, bundled with the build and container.
Update that guide with behavior changes; it describes implemented features and
known limits rather than exposing historical proposals as current behavior.
`capabilities` lists the live registry; `runtime` uses an explicit allowlist of
safe configuration fields. Neither can read arbitrary files, credentials or logs.
Documentation is versioned with the running build, not proof of live service health.

## Remote sandbox

The task sandbox uses the `SandboxProvider` interface, implemented by the E2B SDK adapter. Four top-level tools use it: `read`, `write`, `edit` and `shell`. The catalog tool `sandbox_manage` has the actions `templates`, `build_template` (a task thread action), `status` and `close`. The descriptions are fixed. The `templates` action returns the template list.

The first call of `read`, `write`, `edit` or `shell` in a channel or thread starts its sandbox. `sandboxSession` in `src/sandbox-session.ts` reuses the recorded sandbox and renews its lease. An expired or unreachable sandbox is replaced. The result then starts with "New sandbox started; earlier files are gone." `status` and `close` never start a sandbox.

`read` returns numbered lines, with `offset` and `limit` (at most 2,000 lines) and at most 16,000 characters. Relative paths and `~` start in the sandbox home directory; absolute paths are used as they are. `write` creates parent directories and takes at most 64,000 characters. `edit` needs `old_string` to occur once unless `replace_all` is true; the error gives the count found. `shell` takes `timeout_seconds` (1 to 120, default 30) and returns the exit code, stdout and stderr, each cut at 16,000 characters. A timeout returns exit code 124, and the command may still run.

Mutations share a per-channel resource lock. A lost command result stays uncertain: the sandbox lease expires on its own. Files are gone when the sandbox expires or is closed.

Set `E2B_API_KEY` to a PMServers project token, `E2B_API_URL` to `https://api.pmservers.org/sandboxes`, and `E2B_SANDBOX_URL` to `https://sandbox.pmservers.org`. A sandbox never receives these control-plane credentials or the bot's environment. `E2B_TEMPLATE` chooses the template for new sandboxes. TTL is ten minutes. The SDK's external declarations require `skipLibCheck` with our exact optional property checks; application code keeps strict type checking.

Live smoke test: `npm run sandbox:smoke` uses `.env.development`, creates a temporary sandbox, verifies remote shell and file operations and reconnect, then destroys it. In Discord, ask Slopbot to run a calculation; it runs the work with `shell` in the task sandbox.

## Native function calling and errors

The production executor exposes a captured, sorted function-schema array from ToolRegistry. Native fields produce JSON Schema constraints; MCP input schemas are preserved. Chat requests send `tools` and `tool_choice:auto`. The system prompt contains behavioral instructions, not the catalog or a JSON-only calling format. Streamed IDs, names and argument fragments are assembled before execution. Assistant function calls and matching tool-role results are persisted and reconstructed together. Ordinary JSON in a native-mode answer cannot trigger execution. Legacy saved calls keep their stable operation IDs when replayed with deterministic conversation call IDs. Missing historical pairs are transmitted as labeled evidence instead of invalid tool messages.

Schemas count against context budgets and have separate hashed cache diagnostics. Registry permissions and revocation checks still enforce execution. A schema does not grant access. Native protocol failures surface as `PROVIDER_TOOL_PROTOCOL`; tool errors include sanitized original reasons and preserved causes. `ToolError(message, "failed", {cause})` marks a known execution failure. Unknown write results use `UncertainActionError` and retain reconciliation behavior. `MAX_TOOL_ROUNDS` controls per-attempt rounds, default 64, range 1-1000.

Tool execution errors are saved as failed results and returned to the model with the matching call ID, a sanitized reason and recovery guidance. An all-failed batch continues so the model can correct its calls or explain a block. Three consecutive rounds containing failures disable further tool execution and give the model a final explanation turn. Successful rounds reset this counter. Request interruption and lifecycle/context failures still stop the attempt. Uncertain writes stay unresolved in the operation journal, blocking another write to the same resource until reconciled.


## Persistent files and ownership scopes

`file_store` uses one operator-configured S3 bucket and the existing app-record store. `storage_scope` chooses the directory independently of `scope:mine/public`, which filters listings. All scopes support `save_attachment`, `write`, `save_sandbox`, `to_sandbox`, `list`, `info`, `read`, `link`, `send`, `copy`, `publish`, `unpublish`, and `delete`. `copy` accepts `destination_scope`, defaulting to the source scope.

| storage_scope | Directory | Read access | Mutation control |
| --- | --- | --- | --- |
| user | Personal across permitted servers | Owner; published files readable/discoverable across permitted servers | Owner only, with no admin override |
| server | Shared directory of the current server | Shared files readable by permitted members; private files readable by creator/admins | Anyone can create a new path; existing paths controlled by creator or server admins |
| user_server | Personal within the current server, the default | Owner; published files readable/discoverable within this server | Owner only, with no admin override |

Personal uploads/copies/replacements default to private; server uploads/copies/replacements default to shared. `unpublish` makes a server file private to its creator and current server admins. Existing paths require `overwrite:true` to replace, including admin replacements. Creator identity is preserved across replacements. `owner` is only for reading/copying another person's public file and cannot impersonate write ownership. It is rejected for server scope. Server identity always comes from the trusted Discord request; there is no arbitrary server-ID field. Membership, channel access and current Manage Server permission are checked by the registry and Discord adapter before cached result replay. User/admin fields cannot be supplied by the model.

S3 keys use `users/<owner>/<revision>/<path>` for global personal files, `servers/<server>/shared/<revision>/<path>` for shared-server files, and `servers/<server>/users/<owner>/<revision>/<path>` for personal-within-server files. Global records use the reserved internal `__slopbot_global_files__` record partition. Server files use `stored_server_file` records in their own server partition. User-within-server files keep their existing `stored_file` records and IDs. Metadata stores scope, server when applicable, creator, logical path, object key, byte size, MIME type and visibility. Legacy metadata without scope/creator is interpreted as user_server and retains its owner. Deleted entries are tombstones, retaining revision and permission checks. No database migration or automatic publication is required. Keep the app-record database alongside the bucket; it is the catalog and access-control authority.

Relative paths may have subdirectories but cannot contain traversal, absolute paths, backslashes or control characters. Each file is limited to 10 MiB. Lists support `prefix`, `limit` and `offset`. `scope:mine` lists the requester's files for personal scopes and accessible entries for shared-server scope. `scope:public` lists published entries in the selected storage_scope. Private paths do not appear in public lists. Attachments reuse fresh-message resolution and the bounded Discord downloader; source changes abort before upload. Uploaded blobs with rejected metadata commits are cleaned up, and cleanup failures are logged. Superseded objects are removed after replacement metadata commits. Stored-file inspection reuses the bounded document/image decoder, inspection model budget and event journal. Content is evidence, never instructions. Scope, ownership, visibility and object-version checks run after download and inspection.

PMServers has no anonymous public bucket access or ACLs. `publish` sets visibility and issues a presigned download link; `link` signs a file without changing visibility. Global user publication allows bot discovery across permitted servers. Server/user_server publication stays within the current server. Signed links use public HTTPS even when S3 operations use the private container endpoint. Their default lifetime is 3600 seconds and maximum 604800 seconds. Anyone holding one can download until expiry. `unpublish` prevents new bot access and discovery but does not revoke previously issued links. Delete the object to remove its bytes. Immutable replacement keys prevent an old link from exposing replacement content. Source: https://docs.pmservers.org/storage/share/ and https://docs.pmservers.org/storage/limitations/ .

`send` DMs original bytes only to the requester with a stable nonce. Closed DMs are known failures suggesting a link. Unknown deliveries/uploads/deletions remain journaled as uncertain and are not blindly repeated. Global personal writes share a per-user resource across servers; user_server writes share a per-server/user resource; server writes share a server-wide resource across creators. Copy locks its destination scope. Revision checks protect concurrent updates across registry instances. `to_sandbox` copies a stored file into the task sandbox at `sandbox_path`. It uses the same storage scope and share checks as `read`, and the write takes the sandbox lock. `save_sandbox` reads bounded bytes from the current live task workspace. Server-private sandbox imports recheck current admin status. Storage credentials never enter the sandbox. Loading a private stored file into a task shares those bytes with task participants.

Setup requires an approved PMServers account, a dedicated bucket and bucket-scoped read/write S3 key. Use the console or current `pms storage` CLI; project/AI tokens cannot provision storage. Set `OBJECT_STORAGE_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=pms`, and `AWS_ENDPOINT_URL=https://s3.pmservers.org`. Containers may use `http://garage.pms-storage.svc:3900`. `OBJECT_STORAGE_PUBLIC_ENDPOINT` defaults to public S3 HTTPS. Clients force path style and use checksums only when required. Credentials are operator configuration and never returned by tools.

`npm run storage:smoke` reads `.env.development`, uploads a uniquely named temporary binary object, verifies authenticated and signed public downloads, then deletes it. Unit tests cover all three scopes, every pair of copy destinations, per-user/server isolation, server creator/admin controls, private/public access and revocation, legacy metadata, cache authorization, uploads/overwrites/deletes, lists, sandbox round trips, binary preservation, bounded S3 reads, public URL signing and private DM delivery.

## Structured memory

`memory_remember` saves categorized content through the existing memories table. Categories are fact, meme, preference, lesson, and note. Each entry has tags, validated category-specific details, source policy, revision, update time, and creator attribution. An additive `metadata` text column stores these fields; existing rows default to source-bound facts at revision 1. Legacy fact embeddings remain compatible. SQLite adds the column when absent; PostgreSQL uses an idempotent schema upgrade. Neither upgrade deletes existing data.

Meme details accept media_url, media_type, aliases, when_to_use, humor_notes, and interpretation. Other categories accept subject; lessons also accept when_to_use. Unknown fields and invalid types are rejected. Media links must use HTTPS without embedded credentials. The bot stores the URL without fetching or copying media. A missing media link is valid for a text-only joke. Links may expire. No object storage configuration is required.

Source policy is independent of category and channel access. Memes default to independent; other categories default to source_bound. Independent entries have no memory_sources rows and require no originating message. Source-bound entries default to the current request, with optional supporting source_ids restricted to existing messages in the same server/channel. Source invalidation remains unchanged for source-bound entries. All retrieval, edits, and deletion stay within the original server/channel. Source policies and supporting messages are immutable on update.

`memory` supports query/category/tags plus limit/offset. Search combines text matches and optional cosine similarity, including metadata in embeddings and recalled evidence. Category and tag filters apply before querying embeddings. `memory_update` is saver-only and uses expected_revision plus a metadata compare-and-swap to reject concurrent edits. Supplied tags/details replace previous values. Updates and forgetting invalidate active task context. Index jobs compare their searchable snapshot before committing vectors, preventing an old in-flight embedding from replacing an updated index. Forgetting deletes vectors and deactivates only that entry, leaving source messages and sibling memories intact.

Save and update operation receipts reconcile uncertain commits. Cached memory results revalidate the current entry/revision before reuse, including independent entries with no source message dependency. The existing inline memory tools remain inline, including memory_update. All memory changes use the same permission and operation journal as other tools.

## Tool activity display

Live Discord status shows a pulse header with a changing fun line, one line per tool type with a count, failed or blocked calls, and the current step. It never shows JSON arguments; the current step shows only a clipped search query. Delegated task seeds post directly in the task thread. Parallel program calls update a single status message.

Completed replies default to a summary line such as `🔎 3 web searches`. Server managers can choose **No tool calls**, **Summary**, or **Full expansion** in the web console, or use `/slopbot tool_display mode:none|summary|full`. Full expansion adds one line for each failed or blocked call with its reason. Tool arguments are never shown. This setting persists per server and leaves live progress enabled.


## Sandbox templates

PMServers supports prebuilt images selected with a name or `name:tag`. Slopbot passes the operator's `E2B_TEMPLATE` to the official SDK's `Sandbox.create` for new sandboxes. A model cannot yet choose a template for a task sandbox. The task record keeps the template across lease renewals and reconnects.

To build an environment with preinstalled software, call `sandbox_manage` in a task thread with:

```json
{"action":"build_template","template":"analysis:v1","apt_packages":["ffmpeg"],"pip_packages":["numpy","pandas"]}
```

Builds use the official SDK with the configured PMServers project token and Ubuntu 24.04, then supported apt, run, environment and pip build steps. Python packages install in `/opt/slopbot-python`, a virtual environment on PATH for later commands. Package lists allow names and exact pins, at most 40 per manager; credentials, custom registry URLs, arbitrary host files and build shell snippets are not accepted. Builds are journaled mutations. Known build failures are reported as failures; a lost response stays uncertain and is not blindly rebuilt. A build does not replace an active task sandbox. `action: templates` lists the templates of this PMServers project, and falls back to this server's recorded builds when the project list cannot be read.

Template sandboxes run as the template user in its home directory (`/home/user` in the slopbot template); sudo is unavailable. The `slopbot` template installs poppler-utils (`pdftotext`) and pandoc. Its build is run by `scripts/sandbox-template.mjs`.

Sources reviewed 2026-10-12: https://docs.pmservers.org/sandboxes/templates/ and https://docs.pmservers.org/sandboxes/overview/ . Named tags and image builds are supported; snapshot, fork, private registry and tag-route features remain unsupported.

