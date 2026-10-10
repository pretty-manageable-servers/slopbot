# Service boundaries

The application coordinates requests. Request routing, context building, agent execution and reply rendering live in separate modules. Adapters translate external protocols into application records. See [implementation boundaries](IMPLEMENTATION.md).

| Interface | Responsibility |
| --- | --- |
| Message store | Store message revisions and query permitted context |
| Run store | Append reasoning events and record run results |
| Task store | Durable task inputs, ownership and versioned state |
| Memory search | Retrieve source-linked records within an explicit access scope |
| LLM | Stream typed events and preserve original provider payloads |
| Participation classifier | Decide whether an unaddressed message warrants participation |
| Chat transport | Receive normalized events and send replies or task-thread updates |
| Tool connector | Describe tools and execute an authorized operation with a stable operation ID |

Construct adapters at application startup and inject them into the core. Keep URLs, credentials and provider-specific request fields out of domain logic. No adapter should infer permissions.

Implemented adapters include Discord, streaming Chat Completions, native Decisions classification, embeddings, and SQLite or PostgreSQL/pgvector source/recall storage. A deterministic fake LLM remains available for local tests. The SQLite vector index is replaceable through the Recall and Embeddings interfaces. `DATABASE_URL` selects Postgres at startup. `RuntimeStore` keeps Discord independent of the concrete database adapter. Queue and journal operations await persistence. The shared ToolRegistry supplies validated, permission-checked actions to both Discord commands and the task worker. See TOOLS.md for connector registration.
