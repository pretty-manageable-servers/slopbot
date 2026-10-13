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
- `effect` separates reads from writes. Mixed-action tools supply `writes(args)`. Writes requested in a channel move into a task thread. Arguments and results are posted there, so never expose credentials through either.
- `resource` identifies the shared object being changed. Writes serialize on that key; an unresolved operation blocks later writes to it. Call `assertActive()` again after asynchronous preparation and immediately before the external action.
- Use the stable `operationId` as the external service's idempotency key. Set `retrySafe` only when repeating the operation is safe. Otherwise implement `reconcile`; an unknown result pauses the job. Throw `ToolError` only for a known rejection with no uncertain side effect.

Keep service clients outside the core. Native tools register at startup. Runtime providers replace their own definitions atomically through `replaceProvider()`. Each agent request captures a catalog; changing it changes the prefix version for subsequent requests. An active request keeps its captured catalog, and attempts to invoke changed or revoked definitions are rejected. Existing LLM, embeddings, storage and chat transport interfaces remain independent of tool connectors.

Tools may supply `matchRead(message)` for a narrow, unambiguous read intent. The registry validates it and the same permission-checked executor runs it. For example, an indexing-status request selects `index` directly and returns its actual result. Matches never authorize writes. Legacy text-protocol failures have at most two repair attempts; native calls retain provider IDs and validate their arguments before execution. Each failed run retains its original events.

`file_read` is a member read tool shared by model calls and slash commands. Sources resolve through current Discord permissions; downloads accept only approved media hosts. Add decoders through `FileReader` registration, independent of fetching and vision. Every inspection is a separate durable run with a stable prefix and preserved reasoning events. Completed inspection sources are inherited by subsequent reply runs for the same request.

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

This implementation covers runtime MCP configuration with the existing model protocol. OpenAI Responses API programmatic calling is a separate adapter/continuation change and is not enabled by this feature. OAuth onboarding and host process/stdio servers are also not implemented; use anonymous or bearer-authenticated HTTP/SSE endpoints.

Use `invokeResult()` when metadata is needed. `invoke()` formats text and artifact links for existing command handlers. The action journal stores the complete result with a version marker; older plain-text operation records and agent turns remain readable. Agent turns persist structured results as JSON. The runner adds canonical message sources to its manifest, preserves web citations and artifacts in the model trace, and follows explicit handoffs without parsing display text.

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

`sandbox` uses the `SandboxProvider` interface, implemented by the E2B SDK adapter.
It supports `run`, `read`, `write`, `import_attachment`, `import_storage`, `status`, `close`, `templates`, and `build_template`. Commands, imports and writes
belong in a task thread, and each thread owns one recorded workspace. There are
no model-supplied provider URLs, credentials, or sandbox IDs. Reads/status are
read operations; mutations share a resource lock and are not automatically
retried after uncertain network results. TTL bounds orphan lifetimes. Workspace
IDs and leases live in the existing RecordStore; no database migration is needed.

Set `E2B_API_KEY` to a PMServers project token, `E2B_API_URL` to
`https://api.pmservers.org/sandboxes`, and `E2B_SANDBOX_URL` to
`https://sandbox.pmservers.org`. A sandbox never receives these control-plane
credentials or the bot's environment. An optional `E2B_TEMPLATE` chooses the
default provider template. Per-call `template` overrides it when creating a workspace. TTL is ten minutes, command timeout at most sixty seconds.
The SDK's external declarations require `skipLibCheck` with our exact optional
property checks; application code retains strict type checking.

`import_attachment` takes an absolute sandbox `path`, optional `message_id`, and a zero-based `attachment` index. It defaults to the current/reply attachment, resolves a fresh Discord URL, and downloads up to 10 MiB through the existing restricted media fetcher. Sources must belong to the task thread or its permitted parent channel and pass requester access checks. Source changes abort the import before upload. Original binary bytes go through the SDK file API without being passed through the model or a shell. Imports create/reuse the thread workspace, renew its lease and retain a message source link.

Live smoke test: `npm run sandbox:smoke` uses `.env.development`, creates a
temporary sandbox, verifies remote shell/file operations and reconnect, then
destroys it. In Discord, ask Slopbot to run a calculation in a sandbox; it
moves the work into a task thread and selects the shared sandbox tool.

## Native function calling and errors

The production executor exposes a captured, sorted function-schema array from ToolRegistry. Native fields produce JSON Schema constraints; MCP input schemas are preserved. Chat requests send `tools` and `tool_choice:auto`. The system prompt contains behavioral instructions, not the catalog or a JSON-only calling format. Streamed IDs, names and argument fragments are assembled before execution. Assistant function calls and matching tool-role results are persisted and reconstructed together. Ordinary JSON in a native-mode answer cannot trigger execution. Legacy saved calls keep their stable operation IDs when replayed with deterministic conversation call IDs. Missing historical pairs are transmitted as labeled evidence instead of invalid tool messages.

Schemas count against context budgets and have separate hashed cache diagnostics. Registry permissions and revocation checks still enforce execution. A schema does not grant access. Native protocol failures surface as `PROVIDER_TOOL_PROTOCOL`; tool errors include sanitized original reasons and preserved causes. `ToolError(message, "failed", {cause})` marks a known execution failure. Unknown write results use `UncertainActionError` and retain reconciliation behavior. `MAX_TOOL_ROUNDS` controls per-attempt rounds, default 64, range 1-1000.

Tool execution errors are saved as failed results and returned to the model with the matching call ID, a sanitized reason and recovery guidance. An all-failed batch continues so the model can correct its calls or explain a block. Three consecutive rounds containing failures disable further tool execution and give the model a final explanation turn. Successful rounds reset this counter. Request interruption and lifecycle/context failures still stop the attempt. Uncertain writes stay unresolved in the operation journal, blocking another write to the same resource until reconciled.


## Persistent files and ownership scopes

`file_store` uses one operator-configured S3 bucket and the existing app-record store. `storage_scope` chooses the directory independently of `scope:mine/public`, which filters listings. All scopes support `save_attachment`, `write`, `save_sandbox`, `load_sandbox`, `list`, `info`, `read`, `link`, `send`, `copy`, `publish`, `unpublish`, and `delete`. `copy` accepts `destination_scope`, defaulting to the source scope.

| storage_scope | Directory | Read access | Mutation control |
| --- | --- | --- | --- |
| user | Personal across permitted servers | Owner; published files readable/discoverable across permitted servers | Owner only, with no admin override |
| server | Shared directory of the current server | Shared files readable by permitted members; private files readable by creator/admins | Anyone can create a new path; existing paths controlled by creator or server admins |
| user_server | Personal within the current server, the default | Owner; published files readable/discoverable within this server | Owner only, with no admin override |

Personal uploads/copies/replacements default to private; server uploads/copies/replacements default to shared. `unpublish` makes a server file private to its creator and current server admins. Existing paths require `overwrite:true` to replace, including admin replacements. Creator identity is preserved across replacements. `owner` is only for reading/copying another person's public file and cannot impersonate write ownership. It is rejected for server scope. Server identity always comes from the trusted Discord request; there is no arbitrary server-ID field. Membership, channel access and current Manage Server permission are checked by the registry and Discord adapter before cached result replay. User/admin fields cannot be supplied by the model.

S3 keys use `users/<owner>/<revision>/<path>` for global personal files, `servers/<server>/shared/<revision>/<path>` for shared-server files, and `servers/<server>/users/<owner>/<revision>/<path>` for personal-within-server files. Global records use the reserved internal `__slopbot_global_files__` record partition. Server files use `stored_server_file` records in their own server partition. User-within-server files keep their existing `stored_file` records and IDs. Metadata stores scope, server when applicable, creator, logical path, object key, byte size, MIME type and visibility. Legacy metadata without scope/creator is interpreted as user_server and retains its owner. Deleted entries are tombstones, retaining revision and permission checks. No database migration or automatic publication is required. Keep the app-record database alongside the bucket; it is the catalog and access-control authority.

Relative paths may have subdirectories but cannot contain traversal, absolute paths, backslashes or control characters. Each file is limited to 10 MiB. Lists support `prefix`, `limit` and `offset`. `scope:mine` lists the requester's files for personal scopes and accessible entries for shared-server scope. `scope:public` lists published entries in the selected storage_scope. Private paths do not appear in public lists. Attachments reuse fresh-message resolution and the bounded Discord downloader; source changes abort before upload. Uploaded blobs with rejected metadata commits are cleaned up, and cleanup failures are logged. Superseded objects are removed after replacement metadata commits. Stored-file inspection reuses the bounded document/image decoder, inspection model budget and event journal. Content is evidence, never instructions. Scope, ownership, visibility and object-version checks run after download and inspection.

PMServers has no anonymous public bucket access or ACLs. `publish` sets visibility and issues a presigned download link; `link` signs a file without changing visibility. Global user publication allows bot discovery across permitted servers. Server/user_server publication stays within the current server. Signed links use public HTTPS even when S3 operations use the private container endpoint. Their default lifetime is 3600 seconds and maximum 604800 seconds. Anyone holding one can download until expiry. `unpublish` prevents new bot access and discovery but does not revoke previously issued links. Delete the object to remove its bytes. Immutable replacement keys prevent an old link from exposing replacement content. Source: https://docs.pmservers.org/storage/share/ and https://docs.pmservers.org/storage/limitations/ .

`send` DMs original bytes only to the requester with a stable nonce. Closed DMs are known failures suggesting a link. Unknown deliveries/uploads/deletions remain journaled as uncertain and are not blindly repeated. Global personal writes share a per-user resource across servers; user_server writes share a per-server/user resource; server writes share a server-wide resource across creators. Copy locks its destination scope. Revision checks protect concurrent updates across registry instances. `load_sandbox` forwards storage_scope to a nested `sandbox.import_storage`, preserving the workspace lock and journal. `save_sandbox` reads bounded bytes from the current live task workspace. Server-private sandbox imports recheck current admin status. Storage credentials never enter the sandbox. Loading a private stored file into a task shares those bytes with task participants.

Setup requires an approved PMServers account, a dedicated bucket and bucket-scoped read/write S3 key. Use the console or current `pms storage` CLI; project/AI tokens cannot provision storage. Set `OBJECT_STORAGE_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=pms`, and `AWS_ENDPOINT_URL=https://s3.pmservers.org`. Containers may use `http://garage.pms-storage.svc:3900`. `OBJECT_STORAGE_PUBLIC_ENDPOINT` defaults to public S3 HTTPS. Clients force path style and use checksums only when required. Credentials are operator configuration and never returned by tools.

`npm run storage:smoke` reads `.env.development`, uploads a uniquely named temporary binary object, verifies authenticated and signed public downloads, then deletes it. Unit tests cover all three scopes, every pair of copy destinations, per-user/server isolation, server creator/admin controls, private/public access and revocation, legacy metadata, cache authorization, uploads/overwrites/deletes, lists, sandbox round trips, binary preservation, bounded S3 reads, public URL signing and private DM delivery.

## Tool activity display

Live Discord status shows recent calls with arguments, status, and elapsed time. Delegated task seeds post directly in the task thread. Long live arguments are clipped to fit Discord's message limit; credential fields are redacted. Parallel program calls update a single status message.

Completed replies default to a summary such as `web_search` × 3. Server managers can choose **No tool calls**, **Summary**, or **Full expansion** in the web console, or use `/slopbot tool_display mode:none|summary|full`. Full expansion lists each call with its arguments, status, timing, and failure reason. This setting persists per server and leaves live progress enabled.


## Sandbox templates

PMServers supports prebuilt images selected with a name or `name:tag`. Slopbot passes this name as the first argument to the official SDK's `Sandbox.create`. The task record preserves the selected template across lease renewals and reconnects. A different template is rejected while a workspace is active; close it explicitly before switching. Expired workspaces can select a new template. Existing records without a template remain reusable.

To build an environment with preinstalled software, call `sandbox` with:

```json
{"action":"build_template","template":"analysis:v1","apt_packages":["ffmpeg"],"pip_packages":["numpy","pandas"]}
```

Builds use the official SDK with the configured PMServers project token and Ubuntu 24.04, then supported apt/run/environment/pip build steps. Python packages install in `/opt/slopbot-python`, a virtual environment on PATH for later commands. Package lists allow names and exact pins, at most 40 per manager; credentials, custom registry URLs, arbitrary host files and build shell snippets are not accepted. Builds are journaled mutations in a task thread. Known build failures are reported as failures; a lost response stays uncertain and is not blindly rebuilt. A successful build records its package list; `action:templates` lists this server's recorded builds, not the provider's whole project inventory.

Create a task workspace with `{"action":"run","template":"analysis:v1","command":"python -c 'import pandas; print(pandas.__version__)'"}`. Builds leave an existing task workspace intact. Template sandboxes use `/home/user` and user `user`; sudo is unavailable. The operator's `E2B_TEMPLATE` remains the default when a call omits `template`.

Sources reviewed 2026-10-12: https://docs.pmservers.org/sandboxes/templates/ and https://docs.pmservers.org/sandboxes/overview/ . Named tags and image builds are supported; snapshot, fork, private registry and tag-route features remain unsupported. Live provider builds are separate from the mocked SDK tests.
