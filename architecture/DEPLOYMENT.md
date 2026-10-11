# Managed deployment

PMServers account `teddio496`, project `slop` (`prj_sksyapv5awdj`, Toronto).

| Resource | Configuration |
| --- | --- |
| Bot | `slopbot`, `ctr_bqt2xyw3yvbx`, native runtime, 0.5 vCPU / 1 GiB |
| Database | `slopbot`, `db_arm41bbcteab`, managed Postgres with pgvector |
| Search | SearXNG in the bot container, localhost port 8080 |
| Image | Private `ghcr.io/teddio496/slopbot:20261010-live-r3`, amd64 and arm64 |
| Reply model | `qwen3.8-flash-next` |

PMServers workers are outbound-only and have no service routing. Search runs as a supervised process alongside Node; either process exiting stops the other so the container can restart. Secrets for Discord, the LLM and Postgres are excluded from the search process. The managed database is durable across container replacements.

`DATABASE_URL` selects Postgres. Without it, `npm start` uses the existing local SQLite database. Do not run local and remote bots together with the same Discord token.

The encrypted SQLite snapshot imports in one transaction. Row counts are checked, and a fingerprint prevents a second import. Original reasoning/provider events, task state, source links, profiles, embeddings, tool journals and delivery records are preserved. Worker ownership is acquired anew. The migration key is removed from remote configuration after successful import; the original SQLite database remains locally.

Credentials and resource responses are in git-ignored `data/deployment/`. Never commit or print that directory. GHCR credentials are managed by PMServers. A future deployment should use a package-only token instead of the currently approved broader GitHub login token.

Useful commands from this workspace:

```sh
.tools/pms --project slop container show slopbot
.tools/pms --project slop container logs slopbot --tail 50
.tools/pms --project slop container restart slopbot
```

Test in Discord: mention Slopbot, ask it to search, inspect `/slopbot index` status, then ask about previously indexed messages. Task-thread continuity should survive a container restart. No test messages are sent automatically during deployment.

For updates: build and push a new private GHCR tag, then use `container edit --image <new-tag>`. Changing environment variables replaces the complete environment; pass the full protected env file. Do not run the migration again with a different snapshot against the live database.

Verification: the unit suite, a real Postgres adapter test, complete migration count checks and replay checks passed. The remote container completed migration, returned JSON search results and connected to Discord. GIF issues deferred by the user remain separate from deployment.

## Automatic deployment

`.github/workflows/deploy.yml` tests pull requests. Pushes to `main` also publish an amd64/arm64 image to `ghcr.io/pretty-manageable-servers/slopbot:<commit>` and replace the existing PMServers container. Production images contain no migration snapshot. Existing remote environment variables and the managed database stay in place.

Required GitHub Actions secrets: `PMS_SESSION` holds a dedicated PMServers CLI session JSON; `DEPLOY_GITHUB_TOKEN` downloads the private CLI release and updates the session secret after refresh-token rotation. Deployments run sequentially. The deployment token needs repository access to this repository and read access to the CLI repository. Never use an access JWT alone, since it expires.

AI requests use `https://api.pmservers.org/ai/v1` with the dedicated `slopbot` key and a $1,000 spending limit. Qwen handles chat. The adapter maps the existing Gemma index identity to gateway model `embeddinggemma2`, preserving old vectors. Embeddings are paced and retry HTTP 429. If `/decisions` is unavailable, participation uses the existing chat classifier. The previous direct LLM host was unreachable from the deployed worker.

## Sandbox and CLI credentials

PMServers CLI is pinned to v0.7.0 and downloaded with its SHA256 manifest.
Deployments use a project-scoped `PMS_TOKEN` Actions secret instead of rotating
user sessions. The sandbox has a separate project token in `E2B_API_KEY`; it
uses the PMServers E2B-compatible API and sandbox data-plane URLs. Local secret
files and production environment values are not tracked in Git. Tokens expire
90 days after creation and require replacement before expiry. Sandbox tokens
also grant project management access; never expose them to generated code.

See `TOOLS.md` for sandbox lifecycle and constraints. Sandbox writes use the
existing app-record schema, so no database migration is required.

## Separate search service

`services/search/Dockerfile` bundles the reviewed JSON-enabled SearXNG settings.
The search workflow publishes its own image and updates `slopbot-search` only
when search configuration changes, so ordinary bot deployments do not redeploy
search. Its declared private port 8080 is reachable by same-project containers
at `http://slopbot-search:8080`. The production supervisor supports
`SEARXNG_MODE=external` and does not launch embedded search in that mode.

Protected external access requires a remotely managed Cloudflare Tunnel, a
hostname and an Access service-token policy. Local development supplies the
Access headers through the search adapter. Until that endpoint has been verified,
the existing Tailscale search bridge remains as a transitional fallback. It can
forward to the separate search container. Remove `TAILSCALE_AUTH_KEY` and
`DEV_DATABASE_HOST` from the bot only after development search has moved off it.
The local database tunnel is independent of the bot container throughout.
