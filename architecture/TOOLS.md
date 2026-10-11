# Add a tool once

Register a `ToolDefinition` in `ToolRegistry` at startup. Both the LLM catalog and `/slopbot` commands use that definition. The generic `/slopbot run tool:<name> arguments:<JSON>` supports tools beyond Discord's subcommand limit.

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

Keep service clients outside the core. Register tools before constructing `Application` so the sorted catalog becomes part of its stable prompt prefix. Changing the catalog changes the prefix version. Existing LLM, embeddings, storage and chat transport interfaces remain independent of tool connectors.

Tools may supply `matchRead(message)` for a narrow, unambiguous read intent. The registry validates it and the same permission-checked executor runs it. For example, an indexing-status request selects `index` directly and returns its actual result. Matches never authorize writes. Model tool-protocol failures have at most two repair attempts; each failed run retains its original events.

`file_read` is a member read tool shared by model calls and slash commands. Sources resolve through current Discord permissions; downloads accept only approved media hosts. Add decoders through `FileReader` registration, independent of fetching and vision. Every inspection is a separate durable run with a stable prefix and preserved reasoning events. Completed inspection sources are inherited by subsequent reply runs for the same request.

## Structured results

Tool implementations can return `{ text, status?, sources?, artifacts?, handoff? }`. Sources distinguish canonical messages from web URLs; artifacts carry a URL and label; a handoff carries a thread ID. Tool results are trusted connector output, not model-supplied arguments. Each connector must authorize its source access before returning metadata.

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
It supports `run`, `read`, `write`, `status`, and `close`. Commands and writes
belong in a task thread, and each thread owns one recorded workspace. There are
no model-supplied provider URLs, credentials, or sandbox IDs. Reads/status are
read operations; mutations share a resource lock and are not automatically
retried after uncertain network results. TTL bounds orphan lifetimes. Workspace
IDs and leases live in the existing RecordStore; no database migration is needed.

Set `E2B_API_KEY` to a PMServers project token, `E2B_API_URL` to
`https://api.pmservers.org/sandboxes`, and `E2B_SANDBOX_URL` to
`https://sandbox.pmservers.org`. A sandbox never receives these control-plane
credentials or the bot's environment. An optional `E2B_TEMPLATE` chooses the
provider template. TTL is ten minutes, command timeout at most sixty seconds.
The SDK's external declarations require `skipLibCheck` with our exact optional
property checks; application code retains strict type checking.

Live smoke test: `npm run sandbox:smoke` uses `.env.development`, creates a
temporary sandbox, verifies remote shell/file operations and reconnect, then
destroys it. In Discord, ask Slopbot to run a calculation in a sandbox; it
moves the work into a task thread and selects the shared sandbox tool.
