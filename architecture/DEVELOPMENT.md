# Local development

Development has its own Discord application, AI key and `slopbot_dev` Postgres
schema. It shares the managed PostgreSQL database through a private PMServers
SSH tunnel, rather than forwarding the database through the production bot.

1. Configure `.env.development` with the development token and schema.
2. Register a dedicated SSH public key with `pms ssh-key add`.
3. Set `PMS_DB_TUNNEL=true`, `PMS_CLI_PATH`, `PMS_SSH_KEY`, and `PMS_DB_PORT=15432`.
   Set `DATABASE_URL` to the same database credentials at `127.0.0.1:15432`.
4. Run `npm run dev`. It starts the database tunnel before the bot, recompiles
   TypeScript, and restarts Node when code changes. It closes its own tunnel on
   shutdown and stops the bot if that tunnel exits unexpectedly. An existing
   listener is reused without taking ownership; the database still authenticates
   the connection. Stop other tunnel processes before relying on managed cleanup.

The CLI uses a project token when available, otherwise its PMServers login.
It uses cloudflared and a registered SSH key to reach the jump host. PostgreSQL
is not publicly exposed. A dedicated development schema separates history,
settings, jobs and memory, but is not a database permission boundary.

Search can use a protected HTTPS endpoint with `SEARXNG_ACCESS_CLIENT_ID` and
`SEARXNG_ACCESS_CLIENT_SECRET`. Credentials are sent only over HTTPS and redirects
are refused. During the search-access migration, development still uses the
existing private Tailscale search endpoint; the database no longer depends on it.
Do not remove that bridge until protected search is configured and verified.

Secrets stay in `.env.development` and `data/deployment/`, both ignored by Git.
The launcher rejects the production Discord token. Pushes to main deploy production.
