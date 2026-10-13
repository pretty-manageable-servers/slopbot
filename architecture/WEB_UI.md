# Slopbot configuration console

The console is a static, same-origin frontend in `web/` with a Node HTTP API in the bot process. Enable it explicitly. It uses the existing ToolRegistry, live Discord permissions and database action journal, rather than maintaining a second settings database. The console is served at `/console`. The landing page at `/` serves the static export in `site/out/`, with its `/_next/` files and top-level files. Only the landing HTML allows inline scripts. SQLite and Postgres both work. Existing slash commands and the console see the same settings.

## Sources and branding

Reviewed 2026-10-11:

- [PMS frontend architecture](https://github.com/pretty-manageable-servers/agent-wiki/blob/main/wiki/decisions/2026-10-08-dashboard-static-frontend.md): static frontend, separate authenticated API. PMS uses Next static export and Supabase for cloud accounts. This smaller console uses plain HTML/JS and Discord OAuth because the bot's authority is Discord membership and permissions. Supabase accounts alone cannot establish Discord authority.
- [Brand style](https://github.com/pretty-manageable-servers/agent-wiki/blob/main/wiki/brand-style.md): exact dark/light warm neutral tokens, blue accent, Inter UI, Source Serif 4 titles, JetBrains Mono code. Dark by default; local theme preference.
- [Slopbot branding](https://github.com/pretty-manageable-servers/agent-wiki/blob/main/wiki/components/slopbot.md): general-purpose intelligence, "Where ideas bloom.", six uneven petals with one blue petal. Approved SVGs copied unchanged from `raw/brand/slopbot/`. Light-petal SVG goes on dark backgrounds.

Fonts are served locally, copied from the installed `@fontsource-variable` packages. Font licenses are in `web/assets/licenses/`. No external font requests or copied third-party identity.

## Run

Add to your development environment:

```dotenv
WEB_ENABLED=true
WEB_ORIGIN=http://localhost:3000
WEB_HOST=127.0.0.1
WEB_PORT=3000
DISCORD_CLIENT_ID=your_discord_application_id
DISCORD_CLIENT_SECRET=your_oauth_client_secret
```

In the Discord Developer Portal application's OAuth2 settings, register exactly `http://localhost:3000/auth/callback`. Run `npm run dev`, then open `http://localhost:3000/console`. This requires the existing bot/database configuration too. Obtain the OAuth client secret from the application settings; it is different from the bot token. Never put it in the frontend.

Production uses an HTTPS origin and matching callback. The Slopbot console is served at `https://slopbot.pmservers.org/console`, with the OAuth callback at `https://slopbot.pmservers.org/auth/callback`. Set `WEB_ORIGIN=https://slopbot.pmservers.org` and `WEB_HOST=0.0.0.0`. Sessions are stored in the database. Each login lasts 30 days from its last renewal, and a restart keeps users signed in. Run one bot process per database as before.

## Scopes

| Scope | Controls | Authority |
| --- | --- | --- |
| Server | Participation monitoring, classifier/reply context, automatic reply limits, timing footers | Manage Server, checked on every invocation |
| Channel | Monitor/unmonitor, history window, older imports, pause/resume/status | Manage Server plus channel visibility/history for user and bot |
| User in server | Personal profile fields, permission for others to edit | Current Discord member; target forced to the signed-in user |
| MCP connections | Add, refresh, disable, remove, credentials, and explicit tool grants | Manage Server, rechecked on every configuration request |
| Operator | Models, providers, tokens, credentials, database | Environment only; secrets never returned |

Reply limits are server policy with independent counters in each channel. There is no invented channel/user override hierarchy. History windows are channel-specific. Profiles are public within the server. Each bot installation currently serves one configured guild; multi-server hosting needs a separate lifecycle design.

Removing a monitored channel uses the existing purge behavior and asks for confirmation in the UI. Context saves are two existing tool calls; if the second fails, the UI reports which part was saved. Operations have server-generated IDs and existing audit records. The browser never supplies its identity or an admin flag.

OAuth uses browser-bound, expiring, single-use state. Session cookies are HttpOnly, SameSite=Lax and Secure with HTTPS. Writes require the configured Origin and a per-session CSRF token. Every snapshot checks membership; every invocation re-fetches Discord permissions. API errors avoid provider credentials. The API exposes only the configuration tool allowlist; static file serving uses an allowlist too.pi

MCP configuration uses a separate authenticated `POST /api/mcp` endpoint, not a model-callable management tool. Configuration is guild-scoped and does not require selecting a chat channel. Only admin snapshots include connection metadata and discovered schemas. Saved bearer tokens are never returned. See [runtime MCP connections](TOOLS.md#runtime-mcp-connections) for supported transports, encrypted credential setup, and execution policy.

## Verification

`npm test` includes web configuration, OAuth state/cookie binding, state replay, unauthenticated access, CSRF/origin rejection, revoked access, tool allowlisting, logout and static path protection. Real Discord OAuth needs configured client credentials and a manual sign-in test.
